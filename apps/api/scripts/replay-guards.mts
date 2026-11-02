/**
 * Replays recorded rounds through the interview gateway and records speech guard decisions.
 * Compares against a saved baseline to detect regressions or verify guard behavior changes.
 *
 *   pnpm --filter @orvia/api replay:export      # once, read-only, from the real DB
 *   pnpm --filter @orvia/api replay:guards -- --write-baseline
 *   pnpm --filter @orvia/api replay:guards      # diff against the baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, S2C } from '@orvia/shared';
import { InterviewGateway } from '../src/interview/interview.gateway';
import type { ReplayCorpus, ReplayRound } from './replay-corpus';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'replay');
const CORPUS = join(DIR, 'corpus.json');
const BASELINE = join(DIR, 'baseline.json');

/** Words per transcript fragment. */
const FRAGMENT_WORDS = 6;

type Decision = { atMs: number; what: string; detail: unknown };
type GuardLog = { atMs: number; kind: string; said: string; corrected: boolean }[];
type RoundResult = { id: string; decisions: Decision[]; guardKinds: string[] };

/**
 * Every property is a no-op that resolves, unless given. Robust to the services
 * growing. `then` stays undefined, or `await` would take the stub for a promise
 * that never settles.
 */
function stub<T extends object>(given: Partial<Record<string, unknown>> = {}): T {
  return new Proxy(given, {
    get: (target, p) =>
      p in target ? target[p as string] : p === 'then' ? undefined : () => Promise.resolve(undefined),
  }) as T;
}

function fragments(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += FRAGMENT_WORDS) out.push(words.slice(i, i + FRAGMENT_WORDS).join(' '));
  return out;
}

const settle = () => new Promise<void>((r) => setImmediate(r));

async function replay(round: ReplayRound): Promise<RoundResult> {
  const decisions: Decision[] = [];
  let now = 0;
  const BASE = Date.parse(round.startedAt);

  const intervals: { fn: () => void; every: number; next: number }[] = [];
  const realSetInterval = globalThis.setInterval;
  const realNow = Date.now;
  Date.now = () => BASE + now;

  let events: Record<string, (...a: unknown[]) => void> = {};
  const live = new Proxy(
    { modelId: MODELS.interviewer, candidateVoicedMs: () => 0, hasQueuedAudio: false, close: () => {} } as Record<string, unknown>,
    {
      get: (t, p) =>
        p in t
          ? t[p as string]
          : p === 'then'
            ? undefined
            : (...args: unknown[]) => {
              // A snapshot is the editor echoed back: input, not a decision.
              if (p === 'sendSnapshotNote' || p === 'noteCandidateWorking') return;
              decisions.push({ atMs: now, what: `live.${String(p)}`, detail: args });
            },
    },
  );

  const gw = new InterviewGateway(
    stub({
      createInterviewSession: async (_opts: unknown, ev: typeof events) => {
        events = ev;
        return live;
      },
    }),
    stub({
      elapsedMs: () => now,
      recordFragment: () => {},
      create: async () => ({
        id: round.id,
        startedAt: new Date(BASE),
        systemInstruction: '',
        silenceDurationMs: 1400,
        prefixPaddingMs: 600,
        questions: round.questions,
        starters: round.starters,
      }),
    }),
    stub(),
    stub(),
    stub({ roundOpened: () => {}, roundClosed: () => {} }),
    stub({
      prepare: async (_u: string, input: unknown) => ({ input, extras: {}, ready: {} }),
    }),
  );
  const priv = gw as never as {
    identities: WeakMap<object, string>;
    conns: WeakMap<object, { checks?: { guardLog: GuardLog }; guardLog?: GuardLog }>;
    onStart: (client: object, body: unknown) => Promise<void>;
    onContext: (client: object, body: unknown) => Promise<void>;
    log: unknown;
  };
  const quiet = () => {};
  priv.log = { log: quiet, warn: quiet, error: quiet, debug: quiet, verbose: quiet };

  const client = {
    readyState: 1,
    send: (s: string) => {
      const m = JSON.parse(s) as { event: string; data: unknown };
      // Every two seconds, and audio echoes: neither is a decision.
      if (m.event === S2C.Clock || m.event === S2C.AudioDelta || m.event === S2C.TranscriptDelta) return;
      // `startedAt` is the wall clock at replay time, not a decision.
      if (m.event === S2C.SessionReady) delete (m.data as { startedAt?: string }).startedAt;
      decisions.push({ atMs: now, what: `send.${m.event}`, detail: m.data });
    },
  };
  priv.identities.set(client, 'replay');

  try {
    globalThis.setInterval = ((fn: () => void, every: number) => {
      intervals.push({ fn, every, next: every });
      return { unref() {} } as never;
    }) as never;
    try {
      await priv.onStart(client, { config: round.config, options: round.options });
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    const conn = priv.conns.get(client);
    if (!conn) {
      decisions.push({ atMs: 0, what: 'start-failed', detail: null });
      return { id: round.id, decisions, guardKinds: [] };
    }

    const advance = (to: number) => {
      for (;;) {
        const due = intervals.reduce<(typeof intervals)[number] | null>((a, b) => (!a || b.next < a.next ? b : a), null);
        if (!due || due.next > to) break;
        now = due.next;
        due.next += due.every;
        due.fn();
      }
      now = Math.max(now, to);
    };

    const items = [
      ...round.turns.map((t, i) => ({ at: t.startMs, order: i * 2, turn: t })),
      ...round.context.map((c, i) => ({ at: c.atMs, order: i * 2 + 1, ctx: c })),
    ].sort((a, b) => a.at - b.at || a.order - b.order);

    for (const item of items) {
      advance(item.at);
      if ('ctx' in item && item.ctx) {
        await priv.onContext(client, { kind: item.ctx.kind === 'code' ? 'code' : 'scratchpad', content: item.ctx.content });
      } else if ('turn' in item && item.turn) {
        const t = item.turn;
        if (t.speaker === 'ai') events.onAudio?.('AAAA');
        // Input transcription lands in one burst after the candidate stops;
        // output transcription streams in pieces as the interviewer speaks.
        const parts = t.speaker === 'user' ? [t.text] : fragments(t.text);
        for (const f of parts) events.onTranscript?.({ speaker: t.speaker, text: f, final: true });
        if (t.speaker === 'ai') {
          if (t.interrupted) {
            events.onBoundary?.('interrupted');
            events.onInterrupted?.();
          } else {
            events.onBoundary?.('turnComplete');
            events.onTurnComplete?.();
          }
        }
      }
      await settle();
    }
    // Wherever the gateway keeps it: on the connection before `TurnChecks`, on it after.
    const guards = conn.checks?.guardLog ?? conn.guardLog ?? [];
    for (const g of guards) decisions.push({ atMs: g.atMs, what: 'guard', detail: g });
    return { id: round.id, decisions, guardKinds: guards.map((g) => g.kind) };
  } finally {
    Date.now = realNow;
  }
}

async function main() {
  if (!existsSync(CORPUS)) {
    console.error(`no corpus at ${CORPUS} — run replay:export first`);
    process.exit(1);
  }
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as ReplayCorpus;
  const only = process.argv.find((a) => a.startsWith('--round='))?.slice(8);
  const rounds = corpus.rounds.filter((r) => !only || r.id.startsWith(only));

  const results: RoundResult[] = [];
  for (const r of rounds) results.push(await replay(r));

  if (process.argv.includes('--dump')) {
    for (const r of results) for (const d of r.decisions) console.log(r.id.slice(0, 8), d.atMs, d.what, JSON.stringify(d.detail).slice(0, 160));
  }

  const kinds = results.flatMap((r) => r.guardKinds);
  const tally = Object.entries(kinds.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}));
  console.log(
    `replayed ${results.length} rounds, ${results.reduce((n, r) => n + r.decisions.length, 0)} decisions; ` +
      `guard events: ${tally.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
  );

  /**
   * How closely the replay reproduces what happened live, for rounds recorded
   * since `guard_events` existed. Not a pass/fail: a whole stored turn is not
   * the API's fragments, and the code has changed since most of them ran.
   */
  if (process.argv.includes('--fidelity')) {
    const recorded = new Map(rounds.map((r) => [r.id, (r.guardEvents as { kind: string }[]).map((g) => g.kind)]));
    for (const r of results) {
      const live = recorded.get(r.id) ?? [];
      if (!live.length && !r.guardKinds.length) continue;
      const same = [...live].sort().join() === [...r.guardKinds].sort().join();
      console.log(`${same ? '=' : '≠'} ${r.id.slice(0, 8)}  live: ${live.join(' ') || '-'}  replay: ${r.guardKinds.join(' ') || '-'}`);
    }
  }

  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE, JSON.stringify(results));
    console.log(`baseline written to ${BASELINE}`);
    return;
  }
  if (!existsSync(BASELINE)) {
    console.error('no baseline yet — run with --write-baseline on the code you trust');
    process.exit(1);
  }

  const base = new Map((JSON.parse(readFileSync(BASELINE, 'utf8')) as RoundResult[]).map((r) => [r.id, r]));
  let changed = 0;
  for (const r of results) {
    const b = base.get(r.id);
    const a = JSON.stringify(r.decisions);
    if (b && JSON.stringify(b.decisions) === a) continue;
    changed += 1;
    console.log(`\n✗ ${r.id.slice(0, 8)}: decisions differ from the baseline`);
    // Added and removed rather than position by position: one inserted
    // decision would otherwise shift every line after it into the diff.
    const before = (b?.decisions ?? []).map((d) => JSON.stringify(d));
    const after = r.decisions.map((d) => JSON.stringify(d));
    const left = new Map<string, number>();
    for (const x of before) left.set(x, (left.get(x) ?? 0) + 1);
    const added: string[] = [];
    for (const y of after) {
      const n = left.get(y) ?? 0;
      if (n) left.set(y, n - 1);
      else added.push(y);
    }
    const removed = [...left].flatMap(([x, n]) => Array<string>(n).fill(x));
    for (const x of removed) console.log(`  - ${x.slice(0, 400)}`);
    for (const y of added) console.log(`  + ${y.slice(0, 400)}`);
    if (!added.length && !removed.length) console.log('  (same decisions, in a different order)');
  }
  if (changed) {
    console.log(`\n${changed} of ${results.length} rounds changed`);
    process.exit(1);
  }
  console.log(`all ${results.length} rounds identical to the baseline`);
}

void main();
