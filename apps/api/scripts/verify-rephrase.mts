/**
 * The pure rules of "Say it better" (`src/evaluation/rephrase.ts`): how turns
 * become paragraphs, and how a model reply is joined back onto them. Offline —
 * no model, no database.
 */
import { REPHRASE_MIN_WORDS } from '@orvia/shared';
import {
  buildRephrasePrompt, mergeRephrase, paragraphsOf, rephraseReplySchema, rephraseResponseSchema,
} from '../src/evaluation/rephrase';

let pass = 0;
const fails: string[] = [];
const check = (n: string, ok: boolean, d = '') => {
  if (ok) pass++;
  else fails.push(n);
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${n}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};

const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ');
const ai = (text: string) => ({ speaker: 'ai' as const, text });
const me = (text: string) => ({ speaker: 'user' as const, text });

console.log('\n\x1b[1m1. turns become paragraphs\x1b[0m');
{
  const p = paragraphsOf([
    ai('Question one: Word Ladder.'),
    me(words(8, 'first')),
    me(words(8, 'second')),
    ai('Okay.'),
    me('Okay.'),
    ai('[SYSTEM NOTE: twelve minutes left]'),
    me(words(REPHRASE_MIN_WORDS, 'third')),
  ]);
  check('consecutive candidate turns merge into one answer', p.length === 2 && p[0]!.said.includes('first') && p[0]!.said.includes('second'));
  check('it carries the interviewer line it answered', p[0]?.asked === 'Question one: Word Ladder.');
  check('an acknowledgement under the floor is skipped', !p.some((x) => x.said === 'Okay.'));
  check('a system-note echo is neither a boundary nor context', p[1]?.asked === 'Okay.', `asked=${p[1]?.asked}`);
  check('paragraphs are numbered densely from zero', p.map((x) => x.idx).join() === '0,1');
}
{
  const p = paragraphsOf([me(words(REPHRASE_MIN_WORDS)), ai(`x${'y'.repeat(400)}`), me(words(20))]);
  check('a candidate opening has no interviewer line', p[0]?.asked === null);
  check('a long interviewer line is trimmed', (p[1]?.asked?.length ?? 0) <= 281 && p[1]!.asked!.endsWith('…'));
  check('a paragraph exactly at the floor is kept', p.length === 2);
}

console.log('\n\x1b[1m2. the reply is joined back\x1b[0m');
{
  const paras = paragraphsOf([ai('a'), me(words(20)), ai('b'), me(words(20)), ai('c'), me(words(20))]);
  const reply = rephraseReplySchema.parse({
    items: [
      { id: '0', why: 'You repeated yourself.', better: '  short   answer  ' },
      { id: '0', why: 'second copy', better: 'ignored' },
      { id: '1', why: 'Longer.', better: words(25) },
      { id: '9', why: 'unknown', better: 'dropped' },
    ],
  });
  const items = mergeRephrase(paras, reply);
  check('every paragraph appears once, in order', items.map((i) => i.idx).join() === '0,1,2');
  check('string ids from the enum are read as numbers', items[0]?.better === 'short answer');
  check('a repeated id keeps its first answer', items[0]?.why === 'You repeated yourself.');
  check('a rewrite that is not shorter is dropped, with its reason', items[1]?.better === null && items[1]?.why === null);
  check('a paragraph the model skipped shows no rewrite', items[2]?.better === null);
  check('word counts are measured, not asked for', items[0]?.saidWords === 20 && items[0]?.betterWords === 2);
}
{
  const [item] = mergeRephrase(paragraphsOf([me(words(20))]), { items: [{ id: 0, why: 'x', better: '   ' }] });
  check('a blank rewrite counts as none', item?.better === null && item?.betterWords === null);
}

console.log('\n\x1b[1m3. prompt and schema\x1b[0m');
{
  const paras = paragraphsOf([ai('Q?'), me(words(20, 'alpha'))]);
  const prompt = buildRephrasePrompt('behavioural', paras);
  check('the prompt numbers each paragraph and quotes it', prompt.includes('[0]') && prompt.includes('alpha alpha'));
  check('the prompt forbids adding content', /never add a word of content/i.test(prompt));
  check('the prompt carries the mode hint', prompt.includes('situation, task, action, result'));
  const schema = rephraseResponseSchema([0, 3]) as { properties: { items: { items: { properties: { id: { enum: string[] } }; required: string[] } } } };
  check('ids are a closed enum of the paragraphs sent', schema.properties.items.items.properties.id.enum.join() === '0,3');
  check('why and better are required, so null is emitted rather than omitted',
    ['why', 'better'].every((k) => schema.properties.items.items.required.includes(k)));
}

console.log(`\n${fails.length ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fails.length} failed\x1b[0m`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
