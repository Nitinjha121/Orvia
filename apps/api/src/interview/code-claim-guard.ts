import { norm } from './text-norm';

/**
 * Detects when the interviewer describes code the candidate has not actually written.
 *
 * Checks claims about code ("you have written/added/defined...") against the latest
 * editor buffer snapshot to prevent the interviewer from anticipating unwritten code.
 */

/** The claim verb: written, not "will write" or "once you've written". */
const CLAIM = new RegExp(
  '\\b(?:youve|you have)(?: already| now| just)? ' +
    '(?:written|added|defined|implemented|created|declared|initialized|initialised|set up|coded|put in|included)\\b',
);

/** A preceding word that makes the claim hypothetical. */
const CONDITIONAL = /\b(?:once|when|after|if|before|until|soon as|whether)\s*$/;

const LOOP = /^(?:nested |outer |inner |two |the |a |your )*loops?$/;

/** Kinds whose NAME is the checkable part. */
const NAMED_KINDS =
  'function|method|helper|parameter|param|argument|variable|pointer|pointers|counter|flag';

/** Kinds that may be written without the name appearing ("a hash set" is `set()`). */
const STRUCTURE_KINDS = 'set|array|list|map|dictionary|dict|queue|stack|heap|matrix|grid';

const OBJECT = new RegExp(
  `^(?:the |a |an |your |two |both |some )?((?:[a-z0-9]+ ){0,3}?)(${NAMED_KINDS}|${STRUCTURE_KINDS}|loops?)\\b`,
);

/** Words that describe a thing rather than name it. */
const DESCRIPTIVE = new Set([
  'helper', 'recursive', 'new', 'main', 'first', 'second', 'another', 'separate', 'nested',
  'inner', 'outer', 'extra', 'additional', 'small', 'simple', 'base', 'result', 'output',
  'return', 'empty', 'two', 'both', 'the', 'a', 'an', 'your', 'some', 'its', 'own', 'for',
]);

/**
 * Role names that identifiers may fulfill under different variable names (e.g. `seen` for visited).
 * Checked structurally or permitted to avoid false positives.
 */
const ROLE = new Set([
  'visited', 'seen', 'memo', 'cache', 'answer', 'count', 'index', 'pointer', 'left', 'right',
  'target', 'current', 'previous', 'prev', 'next', 'max', 'min', 'sum', 'total', 'temp', 'start',
  'end', 'direction', 'directions', 'boundary', 'height', 'value', 'key',
]);

const PARAM_KINDS = /^(?:parameter|param|argument)s?$/;

export type CodeClaim = { quote: string; missing: string };

function sentences(turn: string): string[] {
  return turn.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Identifier text, so `max_jump`, `maxJump` and "max jump" all compare equal. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function absentFrom(code: string, object: string): string | null {
  const m = OBJECT.exec(object);
  if (!m) return null;
  const words = (m[1] ?? '').trim().split(' ').filter((w) => w && !DESCRIPTIVE.has(w));
  const kind = m[2]!;
  const body = code.toLowerCase();
  const flat = squash(code);

  if (LOOP.test(`${m[1] ?? ''}${kind}`.trim()) || kind.startsWith('loop')) {
    return /\b(?:for|while)\b|\.foreach\(|\.map\(/.test(body) ? null : kind;
  }
  // "a visited parameter to your dfs function": whatever it is called, a
  // function whose parameter list is empty has no parameter.
  if (PARAM_KINDS.test(kind)) {
    const owner = /\bto (?:the|your|its|that) ([a-z0-9]+) (?:function|method|helper)\b/.exec(object)?.[1];
    if (owner && new RegExp(`\\b${owner}\\s*\\(\\s*\\)`, 'i').test(code)) {
      return `parameter on ${owner}`;
    }
  }
  if (!words.length || words.some((w) => ROLE.has(w))) return null;

  const named = words.join(' ');
  const present = flat.includes(squash(named)) || words.some((w) => w.length >= 3 && flat.includes(w));
  if (present) return null;
  if (new RegExp(`^(?:${STRUCTURE_KINDS})$`).test(kind) && flat.includes(kind)) return null;
  return `${named} ${kind}`;
}

/**
 * The first thing this turn claims was written that the newest snapshot does
 * not contain, or null. `code` undefined means no snapshot was ever sent, and
 * then there is nothing to check against.
 */
export function findCodeClaim(turn: string, code: string | undefined): CodeClaim | null {
  if (code === undefined) return null;
  for (const s of sentences(turn)) {
    const n = norm(s, { joinContractions: true });
    const m = CLAIM.exec(n);
    if (!m || CONDITIONAL.test(n.slice(0, m.index))) continue;

    const rest = n.slice(m.index + m[0].length).trim();
    // "the DFS function and the loops to call it" names two things.
    for (const part of rest.split(/ and | as well as | plus /).slice(0, 3)) {
      const missing = absentFrom(code, part.trim());
      if (missing) return { quote: s.slice(0, 240), missing };
    }
  }
  return null;
}
