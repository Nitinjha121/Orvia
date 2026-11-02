import { Logger } from '@nestjs/common';
import type { MentorToolsService } from './mentor-tools.service';
import {
  BROWSABLE_MODES,
  type BrowsableMode,
  type BrowseFilter,
  type MentorCatalogueService,
} from './mentor-catalogue.service';
import type { LoadedAudio } from './coach.audio';

/**
 * Conversation tool configurations. Separated by scope:
 * - interviewer: no tools (pure evaluation isolation).
 * - coach: memory tools only (operates on the current round).
 * - mentor: read-only access to rounds, reports, transcripts, code, and audio, plus memory.
 */

/**
 * How a round is named. Free text on purpose: the model is never given uuids
 * to repeat back, because it gets them wrong, and "the graph one" is what a
 * person would say anyway.
 */
const ROUND_PARAM = {
  type: 'STRING',
  description:
    'Which round. Use "latest", "first", a number counting back from the most ' +
    'recent ("2" means the round before last), a date like "2026-09-06", or the ' +
    'problem name. Defaults to the latest round.',
} as const;

const listRounds = {
  name: 'list_rounds',
  description:
    'Index of every completed round: date, problems covered, score, verdict, and ' +
    'whether a recording exists. Call this first when you are not certain which ' +
    'round the user means, then pass a "round" value from it to the other tools.',
  parameters: { type: 'OBJECT', properties: {}, required: [] },
};

const getReport = {
  name: 'get_report',
  description:
    "One round's full written report: overall score and verdict, every delivery " +
    'dimension with the score, the assessment and the verbatim quote behind it, ' +
    'the per-question breakdown with what they said versus what a strong answer ' +
    'contains, and the measured speech numbers. Use this before making any claim ' +
    'about a specific round.',
  parameters: { type: 'OBJECT', properties: { round: ROUND_PARAM }, required: [] },
};

const getTranscript = {
  name: 'get_transcript',
  description:
    'The conversation of one round, turn by turn with timestamps, plus the ' +
    'verbatim re-transcription where one exists. Use this when the user asks ' +
    'what they actually said, or what the interviewer actually asked. The ' +
    'verbatim version keeps the filler words and false starts that the main ' +
    'transcript tidies away.',
  parameters: { type: 'OBJECT', properties: { round: ROUND_PARAM }, required: [] },
};

const getCode = {
  name: 'get_code',
  description:
    'The code the user wrote in a coding round, the language, how many times ' +
    'they edited it, and a reference solution to compare against.',
  parameters: { type: 'OBJECT', properties: { round: ROUND_PARAM }, required: [] },
};

const listenToRound = {
  name: 'listen_to_round',
  description:
    "Has someone listen to the user's own audio recording from a round and tell " +
    'you how they SOUNDED — tone, hesitation, pace, filler words, confidence — none ' +
    'of which survive in a transcript. Use it whenever the question is about how ' +
    'they sounded rather than what they said. Only their microphone is recorded, ' +
    "not the interviewer's. It takes ten to thirty seconds, so tell them you are " +
    'listening back BEFORE you call it. A round longer than about fifteen minutes ' +
    'is listened to in parts: the result says how many there are and which minutes ' +
    'each covers, and you get the next one by calling this again with the next ' +
    '"part". Ask for the part that answers the question rather than all of them.',
  parameters: {
    type: 'OBJECT',
    properties: {
      round: ROUND_PARAM,
      focus: {
        type: 'STRING',
        description:
          'Optional: what to listen for, e.g. "nervousness when pushed" or "pace ' +
          'while explaining the optimal approach".',
      },
      part: {
        type: 'INTEGER',
        description:
          'Which part of the recording, counting from 1. Defaults to 1, the ' +
          'opening. Only long rounds have more than one part; the result of any ' +
          'call reports how many there are and the minutes each covers, so ask ' +
          'for the part that covers the stretch the user means.',
      },
    },
    required: [],
  },
};

const listConversations = {
  name: 'list_conversations',
  description:
    'Index of your PAST CONVERSATIONS with this user — coaching sessions and ' +
    'earlier mentor conversations, most recent first, with the date, how long ' +
    'each ran and how many messages. These are not interview rounds; use ' +
    'list_rounds for those. Call this when they refer to something you agreed, ' +
    'practised or discussed before, rather than guessing at it.',
  parameters: { type: 'OBJECT', properties: {}, required: [] },
};

const CONVERSATION_PARAM = {
  type: 'STRING',
  description:
    'Which conversation. Use "latest", a number counting back from the most ' +
    'recent ("2" means the one before last), or a date like "2026-09-07". ' +
    'Defaults to the most recent.',
} as const;

const getConversation = {
  name: 'get_conversation',
  description:
    'One past conversation, word for word. Use it when you need what was ' +
    'actually said or agreed — a drill you set up, a plan they committed to, ' +
    'an explanation they practised. A long conversation is cut to its ENDING, ' +
    'which is where things get agreed.',
  parameters: {
    type: 'OBJECT',
    properties: { conversation: CONVERSATION_PARAM },
    required: [],
  },
};

/* ── the platform around the rounds ───────────────────────────────────────── */

/**
 * Bank tools provide read-only access to question metadata, withholding solutions,
 * rubric notes, and marking criteria from candidate-facing mentor conversations.
 */
const MODE_PARAM = {
  type: 'STRING',
  description:
    'Which bank: "dsa", "concepts", "system_design", "behavioural" or "hr".',
} as const;

const listQuestionLists = {
  name: 'list_question_lists',
  description:
    'Every question list on the platform — the DSA collections (NeetCode 150, ' +
    'company lists), the concept topics, the behavioural competencies, the HR ' +
    'scenarios and the system design bank — with how big each one is and how far ' +
    'through it this user is: solved, worth coming back to, never asked. Call ' +
    'this before suggesting what to practise next, and pass a "list" from it to ' +
    'browse_questions.',
  parameters: { type: 'OBJECT', properties: {}, required: [] },
};

const browseQuestions = {
  name: 'browse_questions',
  description:
    'The questions in one list, or a search across a bank, each marked with what ' +
    'this user has done with it: solved, worth coming back to, asked with no verdict, ' +
    'or never asked. Use it to name actual questions — "you have never been asked ' +
    'a graph problem from this list" — rather than talking in generalities, and ' +
    'to find a question they half-remember. You get the question and what it is ' +
    'about; you do NOT get its answer, and you should not pretend otherwise.',
  parameters: {
    type: 'OBJECT',
    properties: {
      mode: MODE_PARAM,
      list: {
        type: 'STRING',
        description:
          'Which list within that mode, from list_question_lists — a DSA ' +
          'collection like "neetcode150" or "amazon", or a concept topic. Omit ' +
          'it to search every question in that mode, which is what you want ' +
          'when you are looking for one rather than working through a list. The ' +
          'result says which list it actually read.',
      },
      search: {
        type: 'STRING',
        description: 'Optional: match against the title, and for DSA the topics too.',
      },
      only: {
        type: 'STRING',
        description:
          'Filter by what they have done with it: "never_asked", "come_back_to" ' +
          '(asked and not solved), "attempted", or "all". Defaults to all.',
      },
      limit: {
        type: 'INTEGER',
        description: 'How many to return, up to 40. Defaults to 40.',
      },
    },
    required: ['mode'],
  },
};

const getProfile = {
  name: 'get_profile',
  description:
    "What this user told the platform about themselves: the role they are " +
    'targeting, years of experience, the experience and resume text that the ' +
    'experience-based rounds draw on, the job descriptions they have saved, and ' +
    'their session defaults. Use it when advice depends on what they are aiming ' +
    'at. It is their own account of themselves, not anything measured — do not ' +
    'present it back to them as a finding.',
  parameters: { type: 'OBJECT', properties: {}, required: [] },
};

const listUnfinishedRounds = {
  name: 'list_unfinished_rounds',
  description:
    'Rounds with no finished report, and why — still live, cut short, still being ' +
    'written, or failed and worth re-running. list_rounds only shows rounds that ' +
    'finished, so call this when they ask where a report went, or why a round is ' +
    'missing. Only offer a re-run where the result says one would help.',
  parameters: { type: 'OBJECT', properties: {}, required: [] },
};

const remember = {
  name: 'remember',
  description:
    'Save something about this user that you should still know in a future ' +
    'conversation, and that the data cannot tell you: what they are preparing ' +
    'for and by when, a behaviour you have now seen repeatedly, how they want to ' +
    'be coached, or a plan you agreed. Do NOT save scores, metrics or anything ' +
    'already in the history you were given — those are recomputed every time. ' +
    'Saving something close to an existing memory reinforces it rather than ' +
    'duplicating it, which is how you can later tell a habit from a one-off.',
  parameters: {
    type: 'OBJECT',
    properties: {
      content: {
        type: 'STRING',
        description:
          'One or two sentences, written about the user in the second person, ' +
          'specific enough to act on. Not "needs to improve" but "goes quiet for ' +
          'ten seconds before answering complexity questions".',
      },
      kind: {
        type: 'STRING',
        description:
          'One of: goal (what they are working towards), pattern (a recurring ' +
          'behaviour), preference (how they want to be coached), context (their ' +
          'role, target company, timeline).',
      },
      round: {
        type: 'STRING',
        description: 'Optional: the round that prompted this, so it can be traced back.',
      },
    },
    required: ['content'],
  },
};

const listMemories = {
  name: 'list_memories',
  description:
    'Everything you have previously remembered about this user, with how many ' +
    'times each was observed. Your opening context already includes these, so ' +
    'call it only to re-check after saving or forgetting something.',
  parameters: { type: 'OBJECT', properties: {}, required: [] },
};

const forget = {
  name: 'forget',
  description:
    'Delete a memory that has stopped being true — a goal they have met, a ' +
    'weakness they have fixed, a plan that changed. Pass its id from list_memories, ' +
    'or its text. If more than one memory could match, nothing is deleted and the ' +
    'candidates come back with their ids.',
  parameters: {
    type: 'OBJECT',
    properties: {
      memory: { type: 'STRING', description: 'The memory text, or its id.' },
    },
    required: ['memory'],
  },
};

/**
 * The mentor has wide read-only access across past rounds to assess trends.
 * Apart from memory tools, it cannot mutate rounds, reports, or settings.
 */
export const MENTOR_TOOLS: Record<string, unknown>[] = [
  listRounds, getReport, getTranscript, getCode, listenToRound,
  listConversations, getConversation,
  listQuestionLists, browseQuestions, getProfile, listUnfinishedRounds,
  remember, listMemories, forget,
];

/**
 * The coach already has its one round's transcript, report and recording in
 * the prompt, so it gets memory and nothing else. Past conversations, the
 * banks, the profile and the unfinished rounds are account-wide, which is what
 * makes them the mentor's.
 */
export const COACH_TOOLS: Record<string, unknown>[] = [remember, listMemories, forget];

export type ToolCall = { id?: string; name: string; args: Record<string, unknown> };
export type ToolResponse = { id?: string; name: string; response: Record<string, unknown> };

export type ToolDeps = {
  /**
   * The list this conversation's Live session was given. Anything else is
   * answered "no such tool" rather than run: the Live API does not stop a model
   * naming a tool it was never declared, so without this a round's coach could
   * call `get_transcript` on every other round.
   */
  declared: readonly Record<string, unknown>[];
  tools: MentorToolsService;
  /** The banks, the profile and the rounds that produced no report. */
  catalogue: MentorCatalogueService;
  /** From the authenticated socket, never a tool argument. No tool takes a user. */
  userId: string;
  /** For the session coach, the round it is pinned to. */
  pinnedSessionId?: string;
  /** Loads one request-sized part of a recording, shared with the primer path. */
  loadAudio: (path: string | null, part?: number) => Promise<LoadedAudio | null>;
  /** Has a recording listened to and returns the notes, or null. See `ListeningService`. */
  listen: (
    audio: { mimeType: string; data: string },
    o: { round: string; covers?: string; focus?: string },
  ) => Promise<string | null>;
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Models send numbers as numbers, as "2", and occasionally as "part 2". All
 * three mean the same thing and none of them is worth an error — `loadAudio`
 * clamps whatever comes out of this into range anyway.
 */
const num = (v: unknown) => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const m = v.match(/-?\d+/);
    if (m) return Number(m[0]);
  }
  return undefined;
};

/**
 * Builds the handler passed to `LiveEvents.onToolCall`.
 *
 * Calls run SEQUENTIALLY rather than in parallel. They are cheap reads apart
 * from `listen_to_round`, which sends a whole recording part to a listening
 * model, and two of those at once would spend the evaluator chain's quota on
 * a race nobody asked for.
 */
export function buildToolDispatcher(deps: ToolDeps) {
  const log = new Logger('CoachTools');
  const allowed = new Set(deps.declared.map((t) => t.name));

  return async (calls: ToolCall[]): Promise<ToolResponse[]> => {
    const out: ToolResponse[] = [];

    for (const call of calls) {
      const reply = (response: Record<string, unknown>) =>
        out.push({ id: call.id, name: call.name, response });

      if (!allowed.has(call.name)) {
        log.warn(`undeclared tool "${call.name}"`);
        reply({ error: `no such tool: ${call.name}` });
        continue;
      }

      try {
        switch (call.name) {
          case 'list_rounds':
            reply(await deps.tools.listRounds(deps.userId));
            break;

          case 'get_report':
            reply(await deps.tools.getReport(deps.userId, str(call.args.round)));
            break;

          case 'get_transcript':
            reply(await deps.tools.getTranscript(deps.userId, str(call.args.round)));
            break;

          case 'get_code':
            reply(await deps.tools.getCode(deps.userId, str(call.args.round)));
            break;

          case 'list_conversations':
            reply(await deps.tools.listConversations(deps.userId));
            break;

          case 'get_conversation':
            reply(await deps.tools.getConversation(deps.userId, str(call.args.conversation)));
            break;

          case 'listen_to_round': {
            const session = await deps.tools.resolveSession(deps.userId, str(call.args.round));
            if (!session) {
              reply({ error: `no round matches "${str(call.args.round) ?? 'latest'}". Call list_rounds first.` });
              break;
            }
            if (!session.audioPath) {
              reply({ round: session.label, error: 'this round has no recording on disk' });
              break;
            }

            const loaded = await deps.loadAudio(session.audioPath, num(call.args.part) ?? 1);
            if (!loaded) {
              reply({ round: session.label, error: 'the recording could not be read' });
              break;
            }

            const from = Math.round(loaded.fromSeconds / 60);
            const to = Math.round(loaded.toSeconds / 60);
            const total = Math.round(loaded.totalSeconds / 60);
            const more = loaded.parts - loaded.part;
            const covers = loaded.split ? `part ${loaded.part} of ${loaded.parts}, minute ${from} to ${to} of ${total}` : undefined;
            const heard = await deps.listen(loaded.audio, { round: session.label, covers, focus: str(call.args.focus) });
            if (!heard) {
              reply({
                round: session.label,
                error:
                  'nobody could listen to the recording just now. Say so plainly, and answer ' +
                  'from the report and transcript without claiming to know how they sounded.',
              });
              break;
            }

            reply({
              round: session.label,
              /**
               * Listener notes rather than raw audio; prevents the model from
               * falsely claiming direct acoustic observation when reading text summaries.
               */
              listener_notes: heard,
              part: loaded.part,
              parts_total: loaded.parts,
              covers_minutes: `${from} to ${to}`,
              minutes_total: total,
              // `partial` means "there is more of this round nobody listened to",
              // which is the only thing the model must never gloss over. It stays
              // true on a middle part as well as a truncated one.
              partial: loaded.split,
              ...(more > 0 ? { next_part: loaded.part + 1, parts_remaining: more } : {}),
              instruction:
                'These are notes from someone who listened to the recording for you. Use them ' +
                'when delivery comes up, quoting their own phrases. Say "listening back" rather ' +
                'than claiming you heard it yourself, and do not describe any part of the round ' +
                'outside the minutes covered as if it had been listened to.',
            });
            break;
          }

          case 'list_question_lists':
            reply(await deps.catalogue.lists(deps.userId));
            break;

          case 'browse_questions': {
            /**
             * An unknown mode is ANSWERED rather than defaulted. Defaulting to
             * dsa would have the mentor describe a list of coding problems as
             * the user's behavioural progress, which is worse than a miss: the
             * model cannot tell it got a different bank from the one it asked
             * for, and neither can the person listening.
             */
            const mode = str(call.args.mode)?.toLowerCase() as BrowsableMode | undefined;
            if (!mode || !BROWSABLE_MODES.includes(mode)) {
              reply({ error: `mode must be one of ${BROWSABLE_MODES.join(', ')}` });
              break;
            }
            reply(
              await deps.catalogue.browse(deps.userId, {
                mode,
                list: str(call.args.list),
                search: str(call.args.search),
                only: str(call.args.only) as BrowseFilter | undefined,
                limit: num(call.args.limit),
              }),
            );
            break;
          }

          case 'get_profile':
            reply(await deps.catalogue.profile(deps.userId));
            break;

          case 'list_unfinished_rounds':
            reply(await deps.catalogue.unfinishedRounds(deps.userId));
            break;

          case 'remember': {
            const content = str(call.args.content);
            if (!content) {
              reply({ error: 'content is required' });
              break;
            }
            // A round reference is resolved to a real id so the memory can be
            // traced; an unresolvable one is dropped rather than failing the save.
            const ref = str(call.args.round);
            const source = ref
              ? (await deps.tools.resolveSession(deps.userId, ref))?.id ?? null
              : deps.pinnedSessionId ?? null;
            reply(
              await deps.tools.remember(deps.userId, content, str(call.args.kind), source),
            );
            break;
          }

          case 'list_memories':
            reply({
              memories: (await deps.tools.listMemories(deps.userId)).map((m) => ({
                id: m.id,
                kind: m.kind,
                content: m.content,
                times_observed: m.timesObserved,
                last_updated: m.updatedAt.toISOString().slice(0, 10),
              })),
            });
            break;

          case 'forget': {
            const memory = str(call.args.memory);
            if (!memory) {
              reply({ error: 'memory is required' });
              break;
            }
            reply(await deps.tools.forget(deps.userId, memory));
            break;
          }

          default:
            log.warn(`unknown tool "${call.name}"`);
            reply({ error: `no such tool: ${call.name}` });
        }
      } catch (err) {
        // Answered, not thrown: the model blocks until every call comes back,
        // so a failure has to be reported as a result.
        log.error(`tool ${call.name} failed: ${(err as Error).message}`);
        reply({ error: `${call.name} failed: ${(err as Error).message}` });
      }
    }

    return out;
  };
}
