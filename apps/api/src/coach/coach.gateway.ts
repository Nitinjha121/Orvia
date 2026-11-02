import {
  WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket,
  type OnGatewayConnection, type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Inject, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { parse as parseCookie } from 'cookie';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { C2S, S2C, audioChunkSchema, textInputSchema } from '@orvia/shared';
import {
  sessions, turns, verbatimTranscripts, coachConversations, coachMessages,
  type Database,
} from '@orvia/db';
import { DB } from '../db/db.module';
import { GeminiLiveService, type LiveInterviewSession } from '../gemini/live-session.service';
import { AuthService } from '../auth/auth.service';
import { AUTH_COOKIE } from '../auth/auth.guard';
import { EvaluationService } from '../evaluation/evaluation.service';
import { buildCoachPrompt, coachListeningNote, COACH_PRIMER_TEXT } from './coach.prompt';
import { ListeningService } from './listening.service';
import { storeUpstreamEvent, type StoredUpstreamEvent } from '../gemini/upstream-log';
import { loadAudio } from './coach.audio';
import { ArchiveService } from '../storage/archive.service';
import { buildMentorPrompt, MENTOR_PRIMER_TEXT } from './mentor.prompt';
import { MentorDataService } from './mentor-data.service';
import { MentorToolsService } from './mentor-tools.service';
import { MentorCatalogueService } from './mentor-catalogue.service';
import { MENTOR_TOOLS, COACH_TOOLS, buildToolDispatcher } from './coach.tools';
import { expire } from '../common/expire';

/** Bounds the shutdown write, as `SHUTDOWN_TEARDOWN_MS` does for the interview. */
const SHUTDOWN_PERSIST_MS = 10_000;

const startCoachSchema = z.object({
  /**
   * 'session' coaches one finished round and can hear its recording.
   * 'account' looks across rounds to track overall progress and improvement.
   */
  scope: z.enum(['session', 'account']).default('session'),
  sessionId: z.uuid().optional(),
  /** A different voice from the interviewer, so the two never blur together. */
  voice: z.string().default('Aoede'),
});

type Conn = {
  userId: string;
  sessionId: string;
  live: LiveInterviewSession;
  ending: boolean;
  /** What was said, buffered until the conversation ends — see `persist`. */
  log: Transcript;
  /** Every upstream socket event, persisted with the conversation. See `UpstreamEvent`. */
  upstream: StoredUpstreamEvent[];
};

/**
 * What a coach or mentor socket rebuilt from the conversation is told after the
 * replayed turns. Not the interviewer's note: there is no problem to restate
 * and no candidate. What it had looked up with a tool is not in the replay, so
 * it is told to look again rather than to remember.
 */
function conversationResumeNote(o: { owed: boolean; missedVoiceMs?: number; audioFollows: boolean }, extra = ''): string {
  return (
    '[CONVERSATION CONTINUES] The connection to you was remade. The conversation above is ' +
    'what has been said so far — YOU are you, THEM is the person you are talking to — and ' +
    'they heard all of it. Do NOT greet ' +
    'them again, do NOT introduce yourself again, and do not mention the connection, this ' +
    'note or any technical problem. Anything you looked up with a tool before this point ' +
    'is no longer in front of you: call the tool again if you need it. ' +
    (o.audioFollows
      ? 'Their most recent words are not in the transcript above: they follow this note as ' +
        'audio. Listen, and when they finish, reply as if you had been listening throughout.'
      : o.missedVoiceMs !== undefined
        ? `They spoke for about ${Math.max(1, Math.round(o.missedVoiceMs / 1000))} seconds that ` +
          'never reached you. In one short sentence, say you missed that and ask them to say it again.'
        : o.owed
          ? 'Reply to their last message as if you had been listening throughout.'
          : 'They have the floor: say nothing until they speak, then carry on where you left off.') +
    extra
  );
}

/**
 * Accumulates the conversation in memory and writes once when the session ends.
 * Avoids per-turn database writes where out-of-order websocket fragments could
 * race and corrupt transcript order.
 */
class Transcript {
  readonly startedAt = new Date();
  private readonly lines: { speaker: 'ai' | 'user'; text: string; atMs: number }[] = [];

  /**
   * Fragments of one speaker's turn are concatenated rather than stored
   * separately, so a saved conversation reads the way the on-screen one did.
   * A `final: false` fragment REPLACES the open line — interim input
   * transcription is a revisable hypothesis, and appending it would stutter
   * every user turn.
   */
  push(speaker: 'ai' | 'user', text: string, final: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = this.lines[this.lines.length - 1];
    if (last && last.speaker === speaker) {
      last.text = final ? `${last.text} ${trimmed}`.trim() : trimmed;
      return;
    }
    this.lines.push({ speaker, text: trimmed, atMs: Date.now() - this.startedAt.getTime() });
  }

  get rows() {
    return this.lines;
  }
}

/**
 * A second realtime conversation, after the round, about how you came across.
 *
 * Same audio plumbing as the interview; opposite purpose. The interviewer may
 * not help. The coach exists only to help, and unlike the report it can
 * rehearse with you — which is what actually changes delivery.
 */
@WebSocketGateway({ path: '/ws/coach' })
export class CoachGateway implements OnGatewayConnection, OnGatewayDisconnect, BeforeApplicationShutdown {
  private readonly log = new Logger(CoachGateway.name);
  private readonly conns = new WeakMap<WebSocket, Conn>();
  /** The keys of `conns`, which a WeakMap cannot enumerate — for shutdown only. */
  private readonly active = new Set<WebSocket>();
  private readonly identities = new WeakMap<WebSocket, string>();
  /**
   * Sockets between StartSession and `conns.set`. Several awaits sit in that
   * window, and a second StartSession or a disconnect inside it would
   * otherwise open a Live session nothing ever closes.
   */
  private readonly starting = new WeakSet<WebSocket>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly gemini: GeminiLiveService,
    private readonly auth: AuthService,
    private readonly evaluation: EvaluationService,
    private readonly mentorData: MentorDataService,
    private readonly mentorTools: MentorToolsService,
    private readonly mentorCatalogue: MentorCatalogueService,
    private readonly archive: ArchiveService,
    private readonly listening: ListeningService,
  ) {}

  /**
   * `loadAudio` with the archive restore in front of it. The coach and the
   * mentor both read a round's recording long after its report exists, which is
   * exactly when that round is most likely to have been archived — so every
   * path into `loadAudio` goes through here, never the bare import.
   */
  private readonly loadRoundAudio = async (path: string | null, part = 1) =>
    loadAudio(await this.archive.ensureLocal(path), part);

  async handleConnection(client: WebSocket, req: IncomingMessage) {
    client.on('error', (e: Error) => this.log.error(`coach socket error: ${e.message}`));
    const token = parseCookie(req.headers.cookie ?? '')[AUTH_COOKIE];
    const payload = token ? await this.auth.verifyToken(token) : null;
    if (!payload) {
      this.send(client, S2C.Error, { message: 'Not signed in.', fatal: true });
      client.close(4401, 'unauthenticated');
      return;
    }
    this.identities.set(client, payload.sub);
  }

  /**
   * Writes every open conversation before the database pool closes. Nest calls
   * `handleDisconnect` from the WebSocket server's close without awaiting it,
   * and `DbModule` ends the pool straight after, so on a stop the one write
   * this conversation gets would race a closed pool.
   */
  async beforeApplicationShutdown() {
    const open = [...this.active];
    if (!open.length) return;
    const deadline = expire(SHUTDOWN_PERSIST_MS, 'timeout' as const);
    const outcome = await Promise.race([
      Promise.allSettled(open.map((client) => this.end(client, 'api_shutdown'))).then(() => 'done' as const),
      deadline.promise,
    ]);
    deadline.cancel();
    if (outcome === 'timeout') {
      this.log.error(`API stopping: coach conversations still saving after ${SHUTDOWN_PERSIST_MS / 1000}s`);
    }
  }

  async handleDisconnect(client: WebSocket) {
    await this.end(client, null);
  }

  /** `reason` null when the socket is already gone and there is nobody to tell. */
  private async end(client: WebSocket, reason: string | null) {
    const conn = this.conns.get(client);
    if (!conn) return;
    conn.ending = true;
    conn.live.close();
    this.conns.delete(client);
    this.active.delete(client);
    const saved = await this.persist(conn);
    if (reason === null) return;
    this.send(client, S2C.SessionEnded, {
      sessionId: conn.sessionId,
      reason,
      durationMs: saved?.durationMs ?? 0,
      turnCount: saved?.messageCount ?? 0,
    });
  }

  @SubscribeMessage(C2S.StartSession)
  async onStart(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    const userId = this.identities.get(client);
    if (!userId) return this.send(client, S2C.Error, { message: 'Not signed in.', fatal: true });
    if (this.conns.get(client) || this.starting.has(client)) return;

    const parsed = startCoachSchema.safeParse(body);
    if (!parsed.success) {
      return this.send(client, S2C.Error, { message: 'Invalid coach request.', fatal: true });
    }
    const { scope, sessionId, voice } = parsed.data;

    this.starting.add(client);
    try {
      let prompt: string;
      let primerText: string;
      let audio: { mimeType: string; data: string } | null = null;
      /** Said with the listener's notes when only part of the recording fitted. */
      let partialNote: string | undefined;

      let describe: string;

      if (scope === 'account') {
        // No recording: no single round's audio represents a history. What this
        // conversation has instead is the trend across all of them.
        const name = (await this.auth.findById(userId))?.name ?? 'there';
        const [sessions, memories] = await Promise.all([
          this.mentorData.history(userId),
          this.mentorTools.listMemories(userId),
        ]);
        prompt = buildMentorPrompt(name, sessions, memories);
        primerText = MENTOR_PRIMER_TEXT;
        describe = `account mentor (${sessions.length} rounds, ${memories.length} memories)`;
      } else {
        if (!sessionId) {
          return this.send(client, S2C.Error, { message: 'No session given.', fatal: true });
        }
        // Ownership is checked through the evaluation lookup, which is scoped by
        // user — an id alone must never reach someone else's recording.
        const report = await this.evaluation.getForSession(userId, sessionId);
        if (!report || report.status !== 'complete') {
          return this.send(client, S2C.Error, {
            message: 'The report for this round is not ready yet.',
            fatal: true,
          });
        }

        const [session] = await this.db
          .select({ audioPath: sessions.audioPath })
          .from(sessions)
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));

        const [transcript, verbatim] = await Promise.all([
          this.db.select().from(turns).where(eq(turns.sessionId, sessionId)).orderBy(asc(turns.idx)),
          this.db.select().from(verbatimTranscripts).where(eq(verbatimTranscripts.sessionId, sessionId)),
        ]);

        /**
         * Part one only. The coach is pinned to a single round and has no tool
         * to fetch another part, so a long round gives it the opening stretch
         * plus the full transcript — and it is told exactly that, because
         * claiming to have heard a round it only partly heard is precisely the
         * kind of confident wrong fact this codebase keeps out of the models'
         * hands. The mentor is the one that can walk the whole recording.
         */
        const loaded = await this.loadRoundAudio(session?.audioPath ?? null, 1);
        audio = loaded?.audio ?? null;
        if (loaded?.split) {
          partialNote =
            `only the first ${Math.round(loaded.toSeconds / 60)} minutes of a ` +
            `${Math.round(loaded.totalSeconds / 60)} minute round were listened to — you have the ` +
            `full transcript, but do not describe how the later part sounded, and say so plainly ` +
            `if asked about it`;
        }
        prompt = buildCoachPrompt(
          report,
          transcript.map((t) => ({ speaker: t.speaker, text: t.text, startMs: t.startMs })),
          verbatim[0]?.fullText ?? null,
        );
        primerText = COACH_PRIMER_TEXT;
        describe =
          `session coach` +
          (audio
            ? loaded?.split
              ? ` (recording, first ${loaded.toSeconds}s of ${loaded.totalSeconds}s)`
              : ' (with recording)'
            : ' (no recording)');
      }

      const log = new Transcript();

      const tools = scope === 'account' ? MENTOR_TOOLS : COACH_TOOLS;
      const dispatchTool = buildToolDispatcher({
        declared: tools,
        tools: this.mentorTools,
        catalogue: this.mentorCatalogue,
        userId,
        pinnedSessionId: scope === 'session' ? sessionId : undefined,
        loadAudio: this.loadRoundAudio,
        listen: (a, o) => this.listening.listen(a, o),
      });

      /**
       * The listener's notes, once they exist — kept here as well as sent,
       * because a renewal replays the conversation and a note is not part of it.
       */
      let heard: string | null = null;
      const upstream: StoredUpstreamEvent[] = [];
      const startedAt = log.startedAt.getTime();

      if (client.readyState !== client.OPEN) return;
      const live = await this.gemini.createInterviewSession(
        {
          systemInstruction: prompt,
          voice,
          /**
           * The mentor fetches rounds on demand; the coach already has its own
           * round in full and gets memory only. See `coach.tools.ts` for why
           * that split is enforced here rather than asked for in the prompt.
           */
          tools,
          // Generous: the coach should let you finish a practice answer without
          // jumping in, and rehearsing means long pauses mid-thought.
          silenceDurationMs: 1800,
          prefixPaddingMs: 600,
          primer: { text: primerText },
          /**
           * Supplies conversation history explicitly so reconnections do not rely
           * on server-side resumption handles across refused sessions.
           */
          history: async () =>
            log.rows.map((r) => ({ role: r.speaker === 'ai' ? ('model' as const) : ('user' as const), text: r.text })),
          resumeNote: (o) =>
            conversationResumeNote(o, heard ? `\n\n${coachListeningNote(heard, partialNote)}` : ''),
          historyLabel: 'THEM',
        },
        {
          onReady: () => {},
          onAudio: (data) => this.send(client, S2C.AudioDelta, { data }),
          onTranscript: (t) => {
            // Buffered, never awaited — see `Transcript`.
            log.push(t.speaker, t.text, t.final);
            this.send(client, S2C.TranscriptDelta, {
              speaker: t.speaker, text: t.text, final: t.final, atMs: 0,
            });
          },
          onTurnComplete: () => this.send(client, S2C.TurnComplete, {}),
          onInterrupted: () => this.send(client, S2C.Interrupted, {}),
          onGoAway: (secondsLeft) =>
            this.send(client, S2C.SessionWarning, { code: 'go_away', message: 'Reconnecting…', secondsLeft }),
          onReconnected: () =>
            this.send(client, S2C.SessionWarning, { code: 'reconnecting', message: 'Reconnected.' }),
          onError: (err, fatal) => this.send(client, S2C.Error, { message: err.message, fatal }),
          onClosed: () => {},
          onToolCall: dispatchTool,
          onUpstream: (e) => upstream.push(storeUpstreamEvent(e, startedAt)),
        },
      );

      // The socket closed while the Live session was connecting: nothing will
      // ever call `handleDisconnect` for it again.
      if (client.readyState !== client.OPEN) {
        live.close();
        return;
      }
      this.conns.set(client, {
        userId, sessionId: sessionId ?? 'account', live, ending: false, log, upstream,
      });
      /**
       * The listening runs behind the greeting, not in front of it, so the
       * coach answers at once. Its notes go in as a fact: owed exactly once,
       * delivered at the next quiet moment.
       */
      if (audio) {
        const recording = audio;
        void this.listening
          .listen(recording, { round: 'the round being coached', covers: partialNote ? 'the opening part only' : undefined })
          .then((notes) => {
            heard = notes;
            if (this.conns.get(client)?.live === live) live.sendFactNote(coachListeningNote(notes, partialNote));
          })
          .catch((err: Error) => this.log.error(`listening to the round failed: ${err.message}`));
      }
      this.active.add(client);
      this.send(client, S2C.SessionReady, {
        sessionId: sessionId ?? 'account', model: live.modelId, voice,
        startedAt: new Date().toISOString(), durationMinutes: 0,
      });
      this.log.log(`${describe} open`);
    } catch (err) {
      this.log.error(`coach failed to start: ${(err as Error).message}`);
      this.send(client, S2C.Error, { message: (err as Error).message, fatal: true });
    } finally {
      this.starting.delete(client);
    }
  }

  @SubscribeMessage(C2S.AudioChunk)
  onAudio(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    const conn = this.conns.get(client);
    const parsed = audioChunkSchema.safeParse(body);
    if (!conn || conn.ending || !parsed.success) return;
    // Not recorded: the coaching conversation is scratch, not an artefact.
    conn.live.sendAudio(parsed.data.data);
  }

  @SubscribeMessage(C2S.TextInput)
  onText(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    const conn = this.conns.get(client);
    const parsed = textInputSchema.safeParse(body);
    if (conn && parsed.success) conn.live.sendText(parsed.data.text);
  }

  @SubscribeMessage(C2S.StopSession)
  async onStop(@ConnectedSocket() client: WebSocket) {
    await this.end(client, 'user_ended');
  }

  /**
   * Writes the conversation, once, after it is over.
   *
   * A conversation with nothing in it is not written at all — connecting and
   * hanging up before either side spoke is not something the mentor should
   * later find in its own history and try to make sense of.
   */
  private async persist(conn: Conn) {
    const rows = conn.log.rows;
    if (!rows.length) return null;

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - conn.log.startedAt.getTime();
    try {
      const [conversation] = await this.db
        .insert(coachConversations)
        .values({
          userId: conn.userId,
          scope: conn.sessionId === 'account' ? 'account' : 'session',
          sessionId: conn.sessionId === 'account' ? null : conn.sessionId,
          startedAt: conn.log.startedAt,
          endedAt,
          messageCount: rows.length,
          durationMs,
          upstreamEvents: conn.upstream.length ? conn.upstream : null,
        })
        .returning();
      if (!conversation) return null;

      await this.db.insert(coachMessages).values(
        rows.map((r, idx) => ({
          conversationId: conversation.id,
          idx,
          speaker: r.speaker,
          text: r.text,
          atMs: r.atMs,
        })),
      );
      this.log.log(
        `saved a ${conversation.scope} conversation: ${rows.length} messages, ` +
          `${Math.round(durationMs / 1000)}s`,
      );
      return { durationMs, messageCount: rows.length };
    } catch (err) {
      // A conversation that fails to save must not take the socket down with
      // it — the user has already had the conversation.
      this.log.error(`failed to save the conversation: ${(err as Error).message}`);
      return null;
    }
  }

  private send(client: WebSocket, event: string, data: unknown) {
    if (client.readyState !== 1) return;
    client.send(JSON.stringify({ event, data }));
  }
}
