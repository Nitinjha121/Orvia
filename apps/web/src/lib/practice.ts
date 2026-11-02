import { DEFAULT_DRAW_RULES, type DrawRules, type SurpriseMode } from '@orvia/shared';
import { readStored, readStoredJson, writeStoredJson } from './storage';

/**
 * LocalStorage management for random question draw state.
 * Stores cycle start timestamps and user draw rules, while attempted question
 * history is fetched directly from the server.
 */
const KEY = 'orvia.practice.v2';
/** What v1 wrote: one rule set and cycles keyed by bare collection id. */
const KEY_V1 = 'orvia.practice.v1';

type Stored = {
  /**
   * Scope to ISO timestamp mapping for cycle start times.
   * Scopes are namespaced by mode and collection so completing one list does
   * not reset progress in another.
   */
  cycles: Record<string, string>;
  /** Mode → the rules that mode draws under. They are genuinely different. */
  rules: Partial<Record<SurpriseMode, DrawRules>>;
};

const EMPTY: Stored = { cycles: {}, rules: {} };

/**
 * Migrates legacy v1 storage (single rule set and bare collection keys)
 * into namespaced mode rules and scopes.
 */
function migrateV1(): Stored | null {
  try {
    const old = readStoredJson(KEY_V1) as {
      cycles?: Record<string, string>;
      rules?: { difficulties?: string[]; topics?: string[]; avoidRepeats?: boolean; repeatUnsolved?: boolean };
    } | null;
    if (!old || typeof old !== 'object') return null;

    const cycles: Record<string, string> = {};
    for (const [collection, at] of Object.entries(old.cycles ?? {})) {
      if (typeof at === 'string') cycles[`dsa:${collection}`] = at;
    }
    return {
      cycles,
      rules: {
        dsa: {
          ...DEFAULT_DRAW_RULES,
          facets: {
            difficulty: Array.isArray(old.rules?.difficulties) ? old.rules!.difficulties : [],
            topic: Array.isArray(old.rules?.topics) ? old.rules!.topics : [],
          },
          avoidRepeats: old.rules?.avoidRepeats ?? DEFAULT_DRAW_RULES.avoidRepeats,
          repeatUnsolved: old.rules?.repeatUnsolved ?? DEFAULT_DRAW_RULES.repeatUnsolved,
        },
      },
    };
  } catch {
    return null;
  }
}

function read(): Stored {
  // Only an ABSENT v2 blob migrates v1. A corrupt one degrades to defaults:
  // re-reading v1 over it would resurrect rules the user has since changed.
  if (readStored(KEY) === null) {
    const migrated = migrateV1();
    if (migrated) {
      write(migrated);
      return migrated;
    }
    return EMPTY;
  }
  const parsed = readStoredJson(KEY) as Partial<Stored> | null;
  if (!parsed || typeof parsed !== 'object') return EMPTY;
  return {
    cycles: parsed.cycles && typeof parsed.cycles === 'object' ? parsed.cycles : {},
    rules: parsed.rules && typeof parsed.rules === 'object' ? parsed.rules : {},
  };
}

function write(next: Stored) {
  writeStoredJson(KEY, next);
}

/**
 * The rules for one mode, spread over the defaults so a blob written by an
 * older build still yields every field this one reads.
 */
export function loadRules(mode: SurpriseMode): DrawRules {
  const stored = read().rules[mode];
  return {
    ...DEFAULT_DRAW_RULES,
    ...(stored ?? {}),
    facets: stored?.facets && typeof stored.facets === 'object' ? stored.facets : {},
  };
}

export function saveRules(mode: SurpriseMode, rules: DrawRules) {
  const prev = read();
  write({ ...prev, rules: { ...prev.rules, [mode]: rules } });
}

/** ISO timestamp the current cycle began, or null if it never has. */
export function cycleStart(scope: string): string | null {
  return read().cycles[scope] ?? null;
}

/**
 * Begin a fresh cycle for one scope. Returns the new start so the caller can
 * update its own state without re-reading storage.
 *
 * Nothing is deleted — the sessions stay exactly where they were, and the
 * report and progress pages still count them. All this moves is the line for
 * "already asked this time round".
 */
export function resetCycle(scope: string): string {
  const at = new Date().toISOString();
  const prev = read();
  write({ ...prev, cycles: { ...prev.cycles, [scope]: at } });
  return at;
}

/** Undo a reset: the scope counts everything again. */
export function clearCycle(scope: string) {
  const prev = read();
  const { [scope]: _dropped, ...cycles } = prev.cycles;
  write({ ...prev, cycles });
}
