import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { parse as parseCookie } from 'cookie';
import {
  C2S,
  S2C,
  MODELS,
  AUDIO,
  startSessionSchema,
  audioChunkSchema,
  textInputSchema,
  contextPushSchema,
  selectQuestionSchema,
  stopSessionSchema,
  type SessionReadyPayload,
  type SessionEndedPayload,
  type SessionClockPayload,
  type QuestionChangedPayload,
} from '@orvia/shared';
import {
  GeminiLiveService,
  base64Bytes,
  type LiveInterviewSession,
  type StallRemedy,
} from '../gemini/live-session.service';
import { SessionService, type StallRecord } from './session.service';
import type { QuestionTracker } from './question-tracker';
import { untranscribedTurnText } from './untranscribed-turn';
import { TurnChecks } from './turn-checks/turn-checks';
import type { RoundEffects } from './turn-checks/effects';
import { RecordingService } from './recording.service';
import { AuthService } from '../auth/auth.service';
import { EvaluationService } from '../evaluation/evaluation.service';
import { AUTH_COOKIE } from '../auth/auth.guard';
import { RoundPracticeService } from './round-practice.service';
import { expire } from '../common/expire';
import { storeUpstreamEvent, type StoredUpstreamEvent } from '../gemini/upstream-log';

type Conn = {
  userId: string;
  sessionId: string;
  /** Bytes of interviewer audio forwarded to the browser, for the talk ratio. */
  aiAudioBytes: number;
  /** Epoch ms of the last interviewer audio, for the opening gate. */
  lastAiAudioAt?: number;
  /** Epoch ms the round began, for the opening gate. */
  startedAt: number;
  /** Absent only while the upstream session is still being opened. */
  live?: LiveInterviewSession;
  timers: NodeJS.Timeout[];
  ending: boolean;
  /**
   * Whether the interviewer has finished its opening turn.
   *
   * Background microphone noise while the model generates its introduction can
   * cancel the turn via barge-in before audio is emitted. Until the opening
   * turn completes, candidate audio is recorded locally but not forwarded upstream.
   */
  openingDelivered: boolean;
  /** Planned length of the round, so a note can state the real time remaining. */
  plannedMs: number;
  /**
   * Whether the server has told the interviewer that time is short.
   * The model must not conclude this on its own.
   */
  lowTimeNoteSent: boolean;
  /** Clock notes the server has queued, for the closing log line. */
  clockNotesDue: number;
  /** Interviewer turns the API returned no transcript for. See `onUntranscribedTurn`. */
  untranscribedTurns: number;
  /** Interviewer stalls recovered from this round, for the closing log line. */
  stalls: number;
  /** Whether the candidate has been shown a stall banner awaiting a recovery. */
  stallWarned: boolean;
  /**
   * Interrupter silences recorded during the session, persisted for diagnostics.
   */
  stallLog: StallRecord[];
  /** The stall in progress: where it started and how far it has climbed. */
  stallOpen: {
    atMs: number;
    startedAt: number;
    rung: number;
    action: string;
    opening: boolean;
    /** The server stopped hearing the microphone. See `LiveEvents.onStall`. */
    deaf: boolean;
  } | null;
  /**
   * Wall-clock ms the interviewer has been unresponsive, closed stretches only.
   *
   * Subtracted from the round's BUDGET — nobody should spend their forty
   * minutes waiting for a dead model — and from nothing else. `duration_ms`,
   * the recordings and every turn offset stay wall-clock, or the audio no
   * longer lines up with the transcript.
   */
  deadMs: number;
  /** Every check on what the interviewer says, and the conversation state they read. See `TurnChecks`. */
  checks: TurnChecks;
  /** Every upstream socket event, in round time, persisted once at the end. See `UpstreamEvent`. */
  upstreamLog: StoredUpstreamEvent[];
};

/**
 * Interviewer silence that means the opening is not coming, so the microphone
 * gate opens and the candidate can at least be heard.
 *
 * Comfortably past the slowest healthy GAP inside a greeting — the model pauses
 * between sentences, not for eight seconds — while being far quicker than the
 * flat twenty this replaced.
 */
const OPENING_GATE_IDLE_MS = 8_000;

/**
 * Absolute ceiling on holding the gate, whatever the model is doing. A greeting
 * this long is broken by any measure, and leaving the candidate unheard for the
 * whole round is the worse failure.
 */
const OPENING_GATE_MAX_MS = 60_000;

/** How often the interviewer is told the real elapsed time. */
const CLOCK_NOTE_INTERVAL_MS = 5 * 60_000;

/**
 * How often the round's clock is evaluated. It is arithmetic on two numbers,
 * and it has to be a poll rather than a set of timeouts because the budget it
 * reads can stop advancing — see `budgetMs`.
 */
const CLOCK_TICK_MS = 2_000;

/**
 * Grace past the planned length before the round is stopped for the candidate.
 * Gives the interviewer room to finish the sentence the low-time note asked it
 * to close on.
 */
const HARD_STOP_GRACE_MS = 30_000;

/**
 * What the round's clock owes at this budget, decided separately from the timer.
 * Evaluated as a poll so that stalls pause the candidate budget.
 */
export function clockDue(
  budgetMs: number,
  round: { totalMs: number; warnAt: number; nextNoteAt: number; lowTimeSent: boolean },
): { kind: 'stop' } | { kind: 'low' } | { kind: 'note'; atMs: number; nextNoteAt: number } | null {
  if (budgetMs >= round.totalMs + HARD_STOP_GRACE_MS) return { kind: 'stop' };
  if (budgetMs >= round.warnAt) return round.lowTimeSent ? null : { kind: 'low' };
  if (budgetMs < round.nextNoteAt) return null;

  // Whole intervals only, however far the budget moved between ticks — the
  // note states a time, so a stale one is a false statement about the clock.
  let atMs = round.nextNoteAt;
  while (atMs + CLOCK_NOTE_INTERVAL_MS <= budgetMs) atMs += CLOCK_NOTE_INTERVAL_MS;
  return { kind: 'note', atMs, nextNoteAt: atMs + CLOCK_NOTE_INTERVAL_MS };
}

/**
 * `WebSocket.OPEN`. Named rather than written as `1`, and read off the value
 * rather than the type — `ws` is imported type-only here, so the class itself
 * is not in scope to read the constant from.
 */
const WS_OPEN = 1;

/**
 * How long a shutdown waits for the live rounds to close before letting the
 * process exit anyway. A teardown is a flush, two WAV headers and a few row
 * updates; the bound exists so a hung one cannot hold the exit for ever.
 */
const SHUTDOWN_TEARDOWN_MS = 10_000;

/** `end_reason` for a round the API closed because it was stopping. */
export const API_SHUTDOWN_REASON = 'api_shutdown: the API stopped while this round was live';

/**
 * The browser's single connection for an interview.
 *
 * Everything upstream of here — the API key, the Live API socket, the
 * transcript, the recording — stays server side. The browser only ever sees
 * PCM in, PCM out, and transcript text.
 */
@WebSocketGateway({ path: '/ws/interview' })
export class InterviewGateway implements OnGatewayConnection, OnGatewayDisconnect, BeforeApplicationShutdown {
  private readonly log = new Logger(InterviewGateway.name);
  private readonly conns = new WeakMap<WebSocket, Conn>();
  /** The keys of `conns`, which a WeakMap cannot enumerate — for shutdown only. */
  private readonly active = new Set<WebSocket>();
  private stopping = false;
  /** Identity is resolved once at upgrade, not re-checked on every frame. */
  private readonly identities = new WeakMap<WebSocket, string>();

  constructor(
    private readonly gemini: GeminiLiveService,
    private readonly sessionSvc: SessionService,
    private readonly recorder: RecordingService,
    private readonly auth: AuthService,
    private readonly evaluation: EvaluationService,
    private readonly practice: RoundPracticeService,
  ) {}

  /**
   * Authenticates at the WebSocket upgrade using the same httpOnly cookie the
   * REST API issues — the browser attaches it to the upgrade request
   * automatically, so no token ever has to be handled by page JavaScript.
   */
  async handleConnection(client: WebSocket, req: IncomingMessage) {
    client.on('error', (e: Error) => this.log.error(`socket error: ${e.message}`));

    const token = parseCookie(req.headers.cookie ?? '')[AUTH_COOKIE];
    const payload = token ? await this.auth.verifyToken(token) : null;
    if (!payload) {
      this.log.warn('rejecting unauthenticated websocket');
      this.send(client, S2C.Error, { message: 'Not signed in.', fatal: true });
      client.close(4401, 'unauthenticated');
      return;
    }

    this.identities.set(client, payload.sub);
    this.log.log(`client connected (user ${payload.sub.slice(0, 8)})`);
  }

  /**
   * Closes every live round before the database pool shuts down.
   * Ensures teardown finishes and the candidate receives the end event before exit.
   */
  async beforeApplicationShutdown() {
    this.stopping = true;
    const live = [...this.active].flatMap((client) => {
      const conn = this.conns.get(client);
      return conn ? [{ client, conn }] : [];
    });
    if (!live.length) return;
    this.log.warn(`API stopping: closing ${live.length} live round(s)`);

    const deadline = expire(SHUTDOWN_TEARDOWN_MS, 'timeout' as const);
    const outcome = await Promise.race([
      Promise.allSettled(
        live.map(({ client, conn }) =>
          this.teardown(client, conn, API_SHUTDOWN_REASON, 'aborted').catch((err: Error) =>
            this.log.error(`session ${conn.sessionId}: teardown failed: ${err.message}`),
          ),
        ),
      ).then(() => 'done' as const),
      deadline.promise,
    ]);
    deadline.cancel();
    if (outcome === 'timeout') {
      this.log.error(
        `API stopping: live rounds still closing after ${SHUTDOWN_TEARDOWN_MS / 1000}s — ` +
          `exiting anyway, the boot sweep will salvage what is left`,
      );
    }
  }

  async handleDisconnect(client: WebSocket) {
    const conn = this.conns.get(client);
    if (!conn) return;
    this.log.warn(`client disconnected mid-session ${conn.sessionId}`);
    await this.teardown(client, conn, 'client_disconnected', 'aborted').catch((err: Error) =>
      this.log.error(`session ${conn.sessionId}: teardown failed: ${err.message}`),
    );
  }

  /* ── client -> server ───────────────────────────────────────────────────── */

  @SubscribeMessage(C2S.StartSession)
  async onStart(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    if (this.conns.get(client)) return this.send(client, S2C.Error, { message: 'session already running', fatal: false });
    // Started now, it would open after the shutdown hook and be torn down while the pool closes.
    if (this.stopping) return this.send(client, S2C.Error, { message: 'The server is restarting. Try again in a moment.', fatal: true });

    const userId = this.identities.get(client);
    if (!userId) {
      return this.send(client, S2C.Error, { message: 'Not signed in.', fatal: true });
    }

    const parsed = startSessionSchema.safeParse(body);
    if (!parsed.success) {
      return this.send(client, S2C.Error, {
        message: `invalid session config: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        fatal: true,
      });
    }
    let input = parsed.data;

    let sessionId: string | undefined;
    let conn: Conn | undefined;
    try {
      // A drill's setup is rebuilt server-side here, so everything below runs
      // what the SERVER resolved rather than what the client sent.
      const prepared = await this.practice.prepare(userId, input);
      input = prepared.input;
      const created = await this.sessionSvc.create(userId, input, MODELS.interviewer, prepared.extras);
      sessionId = created.id;
      await this.recorder.begin(sessionId);

      // Registered BEFORE the upstream session exists, so the candidate's
      // first words are recorded even if they start talking while we connect.
      // Previously these frames were dropped entirely, and the recording's
      // t=0 lagged the session's by around a second.
      conn = {
        userId,
        sessionId,
        live: undefined,
        timers: [],
        ending: false,
        aiAudioBytes: 0,
        startedAt: Date.now(),
        openingDelivered: false,
        plannedMs: input.options.durationMinutes * 60_000,
        lowTimeNoteSent: false,
        clockNotesDue: 0,
        untranscribedTurns: 0,
        stalls: 0,
        stallWarned: false,
        stallLog: [],
        stallOpen: null,
        deadMs: 0,
        checks: new TurnChecks({
          sessionId,
          mode: input.config.mode,
          questionIds: created.questions.map((q) => q.id),
          questions: created.questions,
          starters: created.starters ?? {},
          effects: this.roundEffects(client, () => conn!),
        }),
        upstreamLog: [],
      };
      const c = conn;
      this.conns.set(client, c);
      this.active.add(client);
      this.evaluation.roundOpened(sessionId);
      const id = sessionId;

      const live = await this.gemini.createInterviewSession(
        {
          systemInstruction: created.systemInstruction,
          voice: input.options.voice,
          silenceDurationMs: created.silenceDurationMs,
          prefixPaddingMs: created.prefixPaddingMs,
          /**
           * The last rung of the stall ladder rebuilds the upstream session
           * from this rather than from the server's own resumption handle —
           * see `LiveInterviewSession.rebuild`. Read at the moment it is
           * needed, because the round has to have happened first.
           */
          history: () => this.sessionSvc.historyFor(id),
          resumeContext: ({ withCode }) => this.resumeContext(c, created.questions, withCode),
        },
        {
          onReady: () => {},
          onAudio: (data) => this.onLiveAudio(client, c, data),
          onTranscript: (t) => this.onLiveTranscript(client, c, t),
          onBoundary: (how) => this.onLiveBoundary(client, how),
          onTurnComplete: () => {
            this.onLiveTurnComplete(client, c).catch((err: Error) =>
              this.log.error(`session ${id}: turn-complete handling failed: ${err.message}`),
            );
          },
          onInterrupted: () => {
            this.sessionSvc
              .markInterrupted(id)
              .catch((err: Error) =>
                this.log.error(`session ${id}: could not mark the barge-in: ${err.message}`),
              )
              .finally(() => this.send(client, S2C.Interrupted, {}));
          },
          onUntranscribedTurn: (durationMs) => this.onUntranscribedTurn(client, c, durationMs),
          onSpuriousNote: (text, heard) => this.onSpuriousNote(c, text, heard),
          onInventedMarkup: (span) => c.checks.inventedMarkup(span),
          onGoAway: (secondsLeft) =>
            this.send(client, S2C.SessionWarning, {
              code: 'go_away',
              message: 'Reconnecting to keep the session alive.',
              secondsLeft,
            }),
          onReconnected: () =>
            this.send(client, S2C.SessionWarning, {
              code: 'reconnecting',
              // What they said into a deaf line reached nobody, and the
              // interviewer is about to ask for it — so they must know to repeat it.
              message: c.stallOpen?.deaf
                ? 'Reconnected. The interviewer did not hear what you said just now — take it from your last point.'
                : 'Reconnected. Carry on.',
            }),
          onStall: (info) => this.onStall(client, c, info),
          onUpstream: (e) => {
            c.upstreamLog.push(storeUpstreamEvent(e, c.startedAt));
            // The row names the model that is actually interviewing.
            if (e.kind === 'failover') {
              void this.sessionSvc.setModel(id, e.model).catch((err: Error) =>
                this.log.error(`session ${id}: could not record the failover: ${err.message}`),
              );
            }
          },
          onError: (err, fatal) => {
            this.send(client, S2C.Error, { message: err.message, fatal });
            // A fatal upstream error can arrive AFTER the socket opened, in
            // which case nothing else will ever close this session. Without
            // this the row sits at `live` forever and its recording is
            // orphaned on disk.
            if (fatal) {
              this.failSession(client, id, err.message).catch((e: Error) =>
                this.log.error(`session ${id}: could not fail the session: ${e.message}`),
              );
            }
          },
          onClosed: () => {},
        },
      );

      /**
       * The candidate may have left while the socket was opening, and teardown
       * has then already finalized the row with no `live` to close. Attaching
       * now would leak the upstream socket and start timers on a dead conn.
       */
      if (c.ending || this.conns.get(client) !== c) {
        this.log.warn(`session ${id}: the candidate left while the interviewer was connecting`);
        live.close();
        return;
      }

      c.live = live;
      if (live.modelId !== MODELS.interviewer) {
        void this.sessionSvc.setModel(id, live.modelId).catch((err: Error) =>
          this.log.warn(`session ${id}: could not record model ${live.modelId}: ${err.message}`),
        );
      }
      this.scheduleTimers(client, c, input.options.durationMinutes);
      c.timers.push(setInterval(() => this.openingGateTick(c), 1_000));

      const ready: SessionReadyPayload = {
        sessionId,
        model: live.modelId,
        voice: input.options.voice,
        startedAt: new Date().toISOString(),
        durationMinutes: input.options.durationMinutes,
        /**
         * The server's order, which is the order the interviewer was given and
         * therefore the order it will read them in. The client used to keep its
         * own copy from the setup screen and the two could disagree.
         */
        questions: created.questions.map((q) => ({
          id: q.id,
          title: q.title,
          difficulty: q.difficulty,
        })),
        ...prepared.ready,
      };
      this.send(client, S2C.SessionReady, ready);
      this.sendClock(client, c);
      this.log.log(`session ${sessionId} live (${live.modelId})`);
    } catch (err) {
      const message = (err as Error).message;
      this.log.error(`failed to start session: ${message}`);
      // A teardown that ran during the connect has finalized the row already.
      if (conn?.ending) return;
      // The connection is registered before the upstream session opens, so a
      // failure here must unregister it — otherwise the socket is stuck
      // reporting "session already running" for a session that never began.
      conn?.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      this.conns.delete(client);
      this.active.delete(client);
      if (sessionId) {
        this.evaluation.roundClosed(sessionId);
        await this.recorder.abort(sessionId).catch(() => {});
        await this.sessionSvc
          .finalize(sessionId, `start_failed: ${message}`, undefined, 'failed')
          .catch(() => {});
      }
      this.send(client, S2C.Error, { message, fatal: true });
    }
  }

  /* ── upstream events ────────────────────────────────────────────────────── */

  private onLiveAudio(client: WebSocket, conn: Conn, data: string) {
    this.send(client, S2C.AudioDelta, { data });
    // Recorded at its position in the round so it lines up with the
    // candidate's track on playback.
    this.recorder.appendAi(conn.sessionId, data, this.sessionSvc.elapsedMs(conn.sessionId));
    // Counted from the forwarded bytes rather than measured off the track
    // above: the talk ratio must reflect what the candidate actually heard.
    conn.aiAudioBytes += base64Bytes(data);
    conn.lastAiAudioAt = Date.now();
  }

  /**
   * Synchronous by contract, and TypeScript is what keeps it that way: an
   * `await` here would let the next fragment overtake this one — fragments
   * arrive milliseconds apart and the Live API callback is not awaited. That
   * swapped fragments on 6 of 12 turns once. See `SessionService.recordFragment`.
   */
  private onLiveTranscript(
    client: WebSocket,
    conn: Conn,
    t: { speaker: 'ai' | 'user'; text: string; final: boolean },
  ) {
    this.send(client, S2C.TranscriptDelta, {
      speaker: t.speaker,
      text: t.text,
      final: t.final,
      atMs: this.sessionSvc.elapsedMs(conn.sessionId),
    });
    if (!t.final) return;
    this.sessionSvc.recordFragment(conn.sessionId, t.speaker, t.text);
    if (t.speaker === 'ai') conn.checks.interviewerFragment(t.text);
    else conn.checks.candidateFragment(t.text);
  }

  /**
   * The boundary checks, run before the live session sends anything at this
   * boundary so that whatever they queue rides in its one send. See
   * `TurnChecks.boundary` for their order.
   */
  private onLiveBoundary(client: WebSocket, how: 'turnComplete' | 'interrupted') {
    this.conns.get(client)?.checks.boundary(how);
  }

  /**
   * What the turn checks may do to this round. `conn` is read lazily because
   * the checks are built inside the object they act on. A fact goes without an
   * options argument when it has none, exactly as the checks used to send it.
   */
  private roundEffects(client: WebSocket, conn: () => Conn): RoundEffects {
    return {
      fact: (note, opts) =>
        opts ? conn().live?.sendFactNote(note, opts) : conn().live?.sendFactNote(note),
      urgent: (note) => conn().live?.sendUrgentNote(note),
      warn: (code, message, secondsLeft) =>
        this.send(client, S2C.SessionWarning, { code, message, secondsLeft }),
      questionChanged: (source) => {
        const tracker = conn().checks.state.questions;
        if (tracker) this.emitQuestionChanged(client, tracker, source);
      },
      saveQuestion: (index) =>
        void this.sessionSvc.setCurrentQuestion(conn().sessionId, index).catch(() => {}),
      clock: () => {
        const c = conn();
        const { remainingMin, secondsLeft } = this.remaining(c);
        return {
          remainingMin,
          secondsLeft,
          plannedMin: Math.round(c.plannedMs / 60_000),
          lowTimeSent: c.lowTimeNoteSent,
          notesSent: c.clockNotesDue,
        };
      },
      elapsedMs: () => this.sessionSvc.elapsedMs(conn().sessionId),
      ended: () => conn().ending,
      log: {
        log: (m) => this.log.log(m),
        warn: (m) => this.log.warn(m),
        error: (m) => this.log.error(m),
      },
    };
  }

  private async onLiveTurnComplete(client: WebSocket, conn: Conn) {
    /**
     * The opening opens the microphone gate only if the interviewer spoke.
     * If the kickoff turn returns empty, the gate remains closed to prevent
     * leaving the model waiting for the candidate.
     */
    if (!conn.openingDelivered && conn.aiAudioBytes > 0) {
      conn.openingDelivered = true;
      this.log.log(`session ${conn.sessionId}: opening delivered, forwarding microphone`);
    }
    try {
      await this.sessionSvc.flush(conn.sessionId);
    } finally {
      this.send(client, S2C.TurnComplete, {});
    }
  }

  /**
   * The interviewer spoke and the API returned no transcript for the turn.
   * A placeholder is inserted at its real position so subsequent evaluation
   * does not treat missing questions as unprompted monologue.
   */
  private onUntranscribedTurn(client: WebSocket, conn: Conn, durationMs: number) {
    conn.untranscribedTurns += 1;
    this.log.error(
      `session ${conn.sessionId}: the interviewer spoke for ` +
        `${(durationMs / 1000).toFixed(1)}s and the API returned NO transcript for ` +
        `the turn (${conn.untranscribedTurns} this round) — recording a placeholder`,
    );
    const text = untranscribedTurnText(durationMs);
    this.send(client, S2C.TranscriptDelta, {
      speaker: 'ai',
      text,
      final: true,
      atMs: this.sessionSvc.elapsedMs(conn.sessionId),
    });
    this.sessionSvc.recordFragment(conn.sessionId, 'ai', text);
  }

  /**
   * The interviewer wrote itself a system note instead of speaking. Its text
   * and audio are already withheld upstream; `SpuriousNoteCheck` answers it.
   */
  private onSpuriousNote(conn: Conn, text: string, heard: boolean) {
    conn.checks.spuriousNote(text, heard);
  }

  /**
   * Notifies the candidate when the interviewer stalls.
   * Short pauses resolve silently without alarming the candidate, while
   * visible pauses (reconnect, rebuild, or unrecoverable) trigger banners.
   */
  private onStall(
    client: WebSocket,
    conn: Conn,
    info: {
      stage: number;
      silentMs: number;
      outageMs: number;
      remedy: StallRemedy;
      action: string;
      recovered?: boolean;
      opening?: boolean;
      deaf?: boolean;
    },
  ) {
    if (conn.ending) return;
    const { stage, silentMs, outageMs, remedy, action, recovered, opening, deaf } = info;

    if (recovered) {
      this.closeStall(conn, true);
      if (conn.stallWarned) {
        conn.stallWarned = false;
        this.send(client, S2C.SessionWarning, {
          code: 'reconnecting',
          // "Back" is wrong for a round that had never started: they were told
          // to hold on, and what they need to know is that the wait is over.
          message: opening
            ? 'The interviewer is starting now — listen out.'
            : 'The interviewer is back. Carry on.',
        });
      }
      return;
    }

    conn.stalls += 1;
    this.log.warn(
      `session ${conn.sessionId}: interviewer ${opening ? 'never opened' : 'stalled'} ` +
        `${(silentMs / 1000).toFixed(0)}s at rung ${stage} ` +
        `(${(outageMs / 1000).toFixed(0)}s since the candidate handed back) — ${action}`,
    );

    // One stretch, however many rungs it climbs, opened where the candidate
    // started waiting rather than where the first rung fired.
    if (!conn.stallOpen) {
      conn.stallOpen = {
        atMs: Math.max(0, this.sessionSvc.elapsedMs(conn.sessionId) - outageMs),
        startedAt: Date.now() - outageMs,
        rung: stage,
        action,
        opening: opening === true,
        deaf: deaf === true,
      };
    } else {
      conn.stallOpen.rung = stage;
      conn.stallOpen.action = action;
      conn.stallOpen.deaf ||= deaf === true;
    }

    const warn = (message: string) => {
      conn.stallWarned = true;
      this.send(client, S2C.SessionWarning, { code: 'stalled', message });
    };

    /**
     * Before the first word the candidate cannot tell a stalled round from
     * microphone issues. Mid-round they have already heard a voice.
     */
    if (opening) {
      warn(
        remedy === 'unrecoverable'
          ? 'The interviewer never started. This is a fault on our side, not ' +
            'your microphone. End the round and start it again — nothing you ' +
            'say now will be part of an interview.'
          : 'The interviewer has not started yet — your microphone is fine. ' +
            'Hold on a moment.',
      );
      return;
    }

    // The clock is paused while the stall is open, so both of these are honest.
    if (deaf) {
      /**
       * Warn clearly when audio input is not reaching upstream. What the
       * candidate says here is lost, so they must pause and repeat once restored.
       */
      warn(
        remedy === 'unrecoverable'
          ? 'The interviewer can no longer hear your microphone. This is a fault ' +
            'on our side, not your mic. End the round — what you said before this ' +
            'point will still be scored.'
          : 'The interviewer stopped hearing your microphone — a fault on our side, ' +
            'not your mic. Reconnecting; the round clock is paused. Once it is back, ' +
            'repeat your last point.',
      );
    } else if (remedy === 'reconnect') {
      warn('Reconnecting to the interviewer — one moment.');
    } else if (remedy === 'rebuild') {
      warn(
        'Rebuilding the interview session — the round clock is paused. ' +
          'Give it a few seconds and carry on where you left off.',
      );
    } else if (remedy === 'unrecoverable') {
      warn(
        'The interviewer is not responding. Your answers are still being ' +
          'recorded, and the round clock is paused — you can keep going, or ' +
          'end the round and have it scored.',
      );
    }
  }

  /**
   * Releases the microphone gate when the opening is not coming.
   * Measures silence rather than fixed elapsed time so longer greetings
   * are not interrupted while audio is still actively arriving.
   */
  private openingGateTick(conn: Conn) {
    if (conn.ending || conn.openingDelivered) return;

    const now = Date.now();
    const idleMs = now - (conn.lastAiAudioAt ?? conn.startedAt);
    const elapsedMs = now - conn.startedAt;
    if (idleMs < OPENING_GATE_IDLE_MS && elapsedMs < OPENING_GATE_MAX_MS) return;

    conn.openingDelivered = true;

    /**
     * The interviewer having spoken and then gone quiet is the expected path.
     * No audio at all indicates a failure where the model never started.
     */
    if (conn.aiAudioBytes > 0) {
      this.log.log(
        `session ${conn.sessionId}: opening finished (interviewer quiet for ` +
          `${(idleMs / 1000).toFixed(0)}s) — microphone gate open`,
      );
    } else {
      this.log.error(
        `session ${conn.sessionId}: the interviewer has said NOTHING ` +
          `${(elapsedMs / 1000).toFixed(0)}s into the round — releasing the ` +
          `microphone gate so the candidate can at least be heard`,
      );
    }
  }

  @SubscribeMessage(C2S.AudioChunk)
  onAudio(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    const conn = this.conns.get(client);
    if (!conn || conn.ending) return;
    const parsed = audioChunkSchema.safeParse(body);
    if (!parsed.success) return;

    // Written to disk unconditionally — the recording is the evaluator's only
    // route to how the candidate actually sounded, so it must cover the whole
    // round including anything said over the introduction.
    this.recorder.append(conn.sessionId, parsed.data.data, this.sessionSvc.elapsedMs(conn.sessionId));

    // Forwarded upstream only once the interviewer has had its opening turn;
    // see `openingDelivered`.
    if (!conn.live || !conn.openingDelivered) return;
    conn.live.sendAudio(parsed.data.data);
  }

  @SubscribeMessage(C2S.AudioStreamEnd)
  onAudioEnd(@ConnectedSocket() client: WebSocket) {
    this.conns.get(client)?.live?.endAudioStream();
  }

  @SubscribeMessage(C2S.TextInput)
  onText(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    const conn = this.conns.get(client);
    const parsed = textInputSchema.safeParse(body);
    if (!conn || !parsed.success) return;
    conn.live?.sendText(parsed.data.text);
  }

  @SubscribeMessage(C2S.ContextPush)
  async onContext(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    const conn = this.conns.get(client);
    const parsed = contextPushSchema.safeParse(body);
    if (!conn || !parsed.success) return;

    const { kind, content } = parsed.data;
    const label = kind === 'code' ? "candidate's code editor" : "candidate's design scratchpad";

    /**
     * Which question the buffer belongs to. The client names it, because the
     * editor knows which buffer it just pushed, but it is only accepted if it
     * is one of THIS round's questions — a stale id would file the code under
     * a question the report then renders it against. Checked against the
     * round's own ids, since a one-question round has no tracker to ask.
     */
    const { state } = conn.checks;
    const tracker = state.questions;
    const claimed = parsed.data.questionId;
    const questionId =
      claimed && state.questionIds.includes(claimed) ? claimed : tracker?.current?.id;

    /**
     * On a multi-question round the note says WHICH problem this is code for.
     * Without it the interviewer received a bare buffer and, after the round
     * moved on, could not tell a half-finished new answer from the previous
     * question's finished one.
     */
    const scope =
      tracker && tracker.length > 1 && questionId
        ? ` (for question ${tracker.indexOfId(questionId) + 1}, "${tracker.byId(questionId)?.title}")`
        : '';

    // The one genuinely disposable note in the round: the next keystroke
    // replaces it, so it is the only thing allowed in the coalescing slot.
    conn.live?.sendSnapshotNote(`Current contents of the ${label}${scope}:\n\n${content}`);
    const bufferId = questionId ?? (state.questionIds.length === 1 ? state.questionIds[0] : undefined);
    if (kind === 'code' && bufferId) state.codeByQuestion.set(bufferId, content);
    // A candidate typing is working, and the stall watchdog must not read their
    // silence while they do it as an interviewer that owes them a reply.
    conn.live?.noteCandidateWorking();
    await this.sessionSvc.saveContext(
      conn.sessionId,
      kind,
      content,
      parsed.data.language,
      questionId,
    );
  }

  /**
   * Explicit candidate question switch override.
   * Allows candidate to advance or move backward if automatic transition detection misses.
   */
  @SubscribeMessage(C2S.SelectQuestion)
  async onSelectQuestion(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    const conn = this.conns.get(client);
    const parsed = selectQuestionSchema.safeParse(body);
    const tracker = conn?.checks.state.questions;
    if (!conn || !tracker || !parsed.success) return;

    const q = conn.checks.candidateSelected(parsed.data.index);
    if (!q) return;

    this.log.log(
      `session ${conn.sessionId}: candidate switched to question ` +
        `${tracker.index + 1}/${tracker.length} (${q.title})`,
    );
    await this.sessionSvc.setCurrentQuestion(conn.sessionId, tracker.index).catch(() => {});

    /**
     * The interviewer is TOLD, so the two do not diverge — the candidate
     * flipping to question three while the interviewer is still asking about
     * question one would otherwise be invisible to it.
     */
    conn.live?.sendFactNote(
      `The candidate has switched their editor to question ${tracker.index + 1}, ` +
        `"${q.title}". If that is not the question you are currently on, they have ` +
        `moved ahead or back on their own — follow them there rather than continuing ` +
        `with the previous question.`,
      // Only the newest switch is true; an undelivered older one is just wrong.
      { key: 'question-switch' },
    );

    this.emitQuestionChanged(client, tracker, 'candidate');
  }

  private emitQuestionChanged(
    client: WebSocket,
    tracker: QuestionTracker,
    source: QuestionChangedPayload['source'],
  ) {
    const q = tracker.current;
    if (!q) return;
    this.send(client, S2C.QuestionChanged, {
      index: tracker.index,
      questionId: q.id,
      title: q.title,
      source,
    } satisfies QuestionChangedPayload);
  }

  @SubscribeMessage(C2S.StopSession)
  async onStop(@ConnectedSocket() client: WebSocket, @MessageBody() body: unknown) {
    const conn = this.conns.get(client);
    if (!conn) return;
    const reason = stopSessionSchema.safeParse(body ?? {}).data?.reason ?? 'user_ended';
    await this.teardown(client, conn, reason, 'completed').catch((err: Error) =>
      this.log.error(`session ${conn.sessionId}: teardown failed: ${err.message}`),
    );
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  /**
   * Closes the stall in progress, banking what it cost.
   * Called on recovery and at teardown.
   */
  private closeStall(conn: Conn, recovered: boolean) {
    const open = conn.stallOpen;
    if (!open) return;
    conn.stallOpen = null;
    const now = Date.now();
    // dead_ms is an integer column in the database; round fractional durations.
    const forMs = Math.round(this.stallCost(conn, open, now));
    conn.deadMs += forMs;
    conn.stallLog.push({
      atMs: Math.round(open.atMs),
      forMs,
      wallMs: Math.round(now - open.startedAt),
      rung: open.rung,
      action: open.action,
      recovered,
      opening: open.opening,
      ...(open.deaf ? { deaf: true } : {}),
    });
  }

  /**
   * The round budget: elapsed wall-clock time minus time spent in stalls.
   * Elapsed time remains wall-clock for recordings and turn offsets, while
   * the budget pauses during outages so candidates are not penalized.
   */
  private budgetMs(conn: Conn): number {
    const open = conn.stallOpen ? this.stallCost(conn, conn.stallOpen, Date.now()) : 0;
    return Math.max(0, this.sessionSvc.elapsedMs(conn.sessionId) - conn.deadMs - open);
  }

  /**
   * What a stall window cost the candidate: its wall time less time they
   * spent talking during it, unless the server could not hear them (in which
   * case the full window is refunded).
   */
  private stallCost(conn: Conn, open: { startedAt: number; deaf: boolean }, to: number): number {
    const wall = to - open.startedAt;
    if (open.deaf) return Math.max(0, wall);
    return Math.max(0, wall - (conn.live?.candidateVoicedMs(open.startedAt, to) ?? 0));
  }

  /**
   * Where the round stands, for an upstream socket that did not live through
   * it. See `LiveOptions.resumeContext`. Only the round's own record: the
   * tracker's question, the buffers the editor pushed, the budget clock.
   */
  private resumeContext(
    conn: Conn,
    questions: { id: string; title: string }[],
    withCode: boolean,
  ): string | undefined {
    const parts: string[] = [];
    const { state } = conn.checks;
    const tracker = state.questions;
    const q = tracker?.current ?? (questions.length === 1 ? questions[0] : undefined);
    if (q) {
      const where = tracker
        ? `You are on question ${tracker.index + 1} of ${tracker.length}, "${q.title}".`
        : `The problem is "${q.title}".`;
      const code = state.codeByQuestion.get(q.id);
      parts.push(
        state.editorUnstarted(q.id)
          ? `${where} The candidate has not written any code for it yet, so it is not finished — ` +
              `stay on it until they have solved it or said they want to move on.`
          : withCode
            ? `${where} Their editor currently holds:\n\n${code}`
            : where,
      );
    }
    const { budgetMs, remainingMin } = this.remaining(conn);
    parts.push(
      `Clock: ${Math.round(budgetMs / 60_000)} of ${Math.round(conn.plannedMs / 60_000)} minutes ` +
        `have passed, so about ${remainingMin} minutes remain. Keep interviewing. Do not close ` +
        `the round and do not mention the time or this note.`,
    );
    return parts.join('\n\n');
  }

  /** What the round has LEFT, off the budget and never the wall clock. */
  private remaining(conn: Conn) {
    const budgetMs = this.budgetMs(conn);
    const remainingMs = Math.max(0, conn.plannedMs - budgetMs);
    return {
      budgetMs,
      remainingMs,
      remainingMin: Math.round(remainingMs / 60_000),
      secondsLeft: Math.round(remainingMs / 1000),
    };
  }

  private sendClock(client: WebSocket, conn: Conn) {
    const { budgetMs, remainingMs } = this.remaining(conn);
    this.send(client, S2C.Clock, { remainingMs, budgetMs } satisfies SessionClockPayload);
  }

  /**
   * Warns the interviewer (not the candidate) that time is short, then hard-stops
   * at the cap. Without the warning the model has no clock and will happily run
   * past the end of the round mid-question.
   */
  private scheduleTimers(client: WebSocket, conn: Conn, durationMinutes: number) {
    const totalMs = durationMinutes * 60_000;
    const warnAt = Math.max(totalMs - 3 * 60_000, totalMs * 0.8);

    /**
     * The real elapsed time, sent at regular intervals so the model does not
     * have to guess the elapsed time.
     * Driven off the candidate budget rather than fixed wall-clock timeouts.
     */
    let noteAt = CLOCK_NOTE_INTERVAL_MS;
    conn.timers.push(
      setInterval(() => {
        if (conn.ending) return;
        this.sendClock(client, conn);
        const due = clockDue(this.budgetMs(conn), {
          totalMs,
          warnAt,
          nextNoteAt: noteAt,
          lowTimeSent: conn.lowTimeNoteSent,
        });
        if (!due) return;

        if (due.kind === 'stop') {
          this.teardown(client, conn, 'time_up', 'completed').catch((err: Error) =>
            this.log.error(`session ${conn.sessionId}: teardown failed: ${err.message}`),
          );
          return;
        }

        if (due.kind === 'low') {
          conn.lowTimeNoteSent = true;
          conn.clockNotesDue += 1;
          conn.live?.sendFactNote(
            'Roughly three minutes remain. Finish the current thread and begin closing the round.',
            { key: 'clock' },
          );
          this.send(client, S2C.SessionWarning, {
            code: 'time_low',
            message: '3 minutes remaining',
            secondsLeft: this.remaining(conn).secondsLeft,
          });
          return;
        }

        noteAt = due.nextNoteAt;
        conn.clockNotesDue += 1;
        conn.live?.sendFactNote(
          `Clock: ${Math.round(due.atMs / 60_000)} of ${durationMinutes} minutes have passed, ` +
            `so about ${Math.round((totalMs - due.atMs) / 60_000)} minutes remain. Keep ` +
            `interviewing. Do not close the round and do not mention the time or this note.`,
          // A later reading makes an undelivered earlier one false, so it
          // replaces rather than queues behind it.
          { key: 'clock' },
        );
      }, CLOCK_TICK_MS),
    );
  }

  /**
   * Ends a session that failed upstream. Handles the window where the Live API
   * has already accepted the connection but the gateway has not yet registered
   * the connection object.
   */
  private async failSession(client: WebSocket, sessionId: string, message: string) {
    const conn = this.conns.get(client);
    if (conn) {
      await this.teardown(client, conn, `error: ${message}`, 'failed');
      return;
    }
    await this.recorder.abort(sessionId).catch(() => {});
    await this.sessionSvc
      .finalize(sessionId, `error: ${message}`, undefined, 'failed')
      .catch(() => {});
  }

  /**
   * A round's diagnostic record failing to save must not stop the round ending,
   * but must not vanish either: a silent catch here hid a refused stall write
   * until test:deaf found the row empty.
   */
  private persistFailed(conn: Conn, what: string) {
    return (err: Error) =>
      this.log.error(`session ${conn.sessionId}: could not save its ${what}: ${err.message}`);
  }

  private async teardown(
    client: WebSocket,
    conn: Conn,
    reason: string,
    status: 'completed' | 'aborted' | 'failed',
  ) {
    if (conn.ending) return;
    conn.ending = true;
    // `timers` holds the opening-gate and clock INTERVALS as well as one-shot
    // timeouts.
    conn.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    /**
     * A round that ended while the interviewer was still dead holds the longest
     * outage of all, and it is the one nothing would otherwise record: both
     * rounds this was built for ended exactly that way, with the candidate
     * giving up mid-silence.
     */
    this.closeStall(conn, false);

    let audioPath: string | undefined;
    let durationMs = 0;
    let turnCount = 0;
    let finalized = false;
    try {
      if (conn.stallLog.length) {
        await this.sessionSvc
          .saveStalls(conn.sessionId, conn.stallLog, conn.deadMs)
          .catch(this.persistFailed(conn, 'stalls'));
      }
      if (conn.checks.guardLog.length) {
        await this.sessionSvc
          .saveGuardEvents(conn.sessionId, conn.checks.guardLog)
          .catch(this.persistFailed(conn, 'guard events'));
      }
      if (conn.upstreamLog.length) {
        await this.sessionSvc
          .saveUpstreamEvents(conn.sessionId, conn.upstreamLog)
          .catch(this.persistFailed(conn, 'upstream events'));
      }

      const handle = conn.live?.handle;
      conn.live?.close();
      if (handle) await this.sessionSvc.saveResumptionHandle(conn.sessionId, handle).catch(() => {});

      const paths = await this.recorder
        .finalize(conn.sessionId)
        .catch(() => ({ audioPath: undefined, aiAudioPath: undefined }));
      audioPath = paths.audioPath;
      const aiSpeakingMs = Math.round(
        (conn.aiAudioBytes / (AUDIO.outputSampleRate * AUDIO.bytesPerSample)) * 1000,
      );
      await this.sessionSvc.setAiSpeakingMs(conn.sessionId, aiSpeakingMs).catch(() => {});
      ({ durationMs, turnCount } = await this.sessionSvc.finalize(
        conn.sessionId,
        reason,
        audioPath,
        status,
        paths.aiAudioPath,
      ));
      finalized = true;
    } catch (err) {
      this.log.error(`session ${conn.sessionId}: finalizing failed: ${(err as Error).message}`);
    } finally {
      // Whatever failed above, the browser is told the round is over and the
      // socket is free to start another.
      const payload: SessionEndedPayload = {
        sessionId: conn.sessionId,
        reason,
        durationMs,
        turnCount,
        audioPath,
      };
      this.send(client, S2C.SessionEnded, payload);
      this.conns.delete(client);
      this.active.delete(client);
    }

    const { repeat, spurious, clock } = conn.checks;
    if (repeat.corrected > 0) {
      this.log.warn(
        `session ${conn.sessionId}: corrected ${repeat.corrected} repeated ` +
          `question(s) — the interviewer asked something it had already asked`,
      );
    }
    if (spurious.count > 0) {
      this.log.warn(
        `session ${conn.sessionId}: suppressed ${spurious.count} fabricated ` +
          `system note(s) from the interviewer`,
      );
    }
    if (conn.untranscribedTurns > 0) {
      this.log.warn(
        `session ${conn.sessionId}: ${conn.untranscribedTurns} interviewer turn(s) were ` +
          `spoken but never transcribed by the API — placeholders are in the transcript, ` +
          `and the questions themselves are recoverable only from the recording`,
      );
    }
    if (conn.stallLog.length) {
      const recovered = conn.stallLog.filter((x) => x.recovered).length;
      this.log.warn(
        `session ${conn.sessionId}: the interviewer went silent ${conn.stallLog.length} ` +
          `time(s) for ${(conn.deadMs / 1000).toFixed(0)}s in total, ${recovered} of which ` +
          `it came back from — the round's budget was extended by that much`,
      );
    }
    if (clock.claims > 0) {
      this.log.warn(
        `session ${conn.sessionId}: the interviewer stated the clock ${clock.claims} ` +
          `time(s) without being told it — the report must not treat the round as ` +
          `having run out of time`,
      );
    }

    // Evaluation runs only for rounds that actually happened. Scoring an
    // aborted or failed session produces a confusing report, and burns the
    // most expensive model call in the product on nothing.
    if (finalized && status === 'completed' && turnCount >= 2) {
      // A failed insert is already logged by the pipeline it would have started.
      void this.evaluation.enqueue(conn.sessionId).catch(() => {});
    }
    // After `enqueue` has marked the run, so no poll falls between the two.
    this.evaluation.roundClosed(conn.sessionId);
  }

  private send(client: WebSocket, event: string, data: unknown) {
    if (client.readyState !== WS_OPEN) return;
    client.send(JSON.stringify({ event, data }));
  }
}
