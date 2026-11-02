/**
 * Browser end-to-end suite driving Chromium with simulated audio capture,
 * testing microphone worklets, WebSockets, audio playback measurement,
 * code editor interactions, and report rendering.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertTestDatabase } from './guard';
import { preflight } from './preflight';

/** The playbook page is private and absent from the public repo. */
const HAS_PLAYBOOK = existsSync(join(import.meta.dirname, '../../apps/web/src/components/PlaybookPage.tsx'));

const exec = promisify(execFile);

const WEB = process.env.E2E_WEB ?? 'http://localhost:5173';
const API = process.env.E2E_API ?? 'http://localhost:8787';
// Deliberately outside the repo: Chrome's --use-file-for-fake-audio-capture
// does not handle spaces in directory paths when configuring the fake audio
// device.
const TMP = '/tmp/orvia-browser-e2e';
const HEADED = process.env.HEADED === '1';

// It signs up throwaway accounts and records real rounds.
assertTestDatabase(process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5432/orvia_test');

/* ── harness ───────────────────────────────────────────────────────────────── */

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phase = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/** Polls a predicate rather than sleeping a fixed amount. */
let dumpPage: (() => Promise<void>) | null = null;

async function until(fn: () => Promise<boolean> | boolean, ms: number, label: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {
      /* keep waiting */
    }
    await sleep(400);
  }
  console.log(`      \x1b[2m(timed out after ${(ms / 1000).toFixed(0)}s waiting for ${label})\x1b[0m`);
  if (dumpPage) await dumpPage();
  return false;
}

/* ── the candidate's voice ─────────────────────────────────────────────────── */

/**
 * Chrome loops the capture file, so this is written long enough to cover a
 * whole round and generic enough that looping still sounds like someone
 * talking rather than a stuck record.
 */
const SCRIPT = [
  'Sure, thanks for having me.',
  'My approach here would be to use a hash map.',
  'I would iterate through the array once, and for each element I check whether the target minus that element is already in the map.',
  'If it is, I return the two indices. If not, I store the current value and its index and continue.',
  'That gives me linear time, order n, and linear space, order n, because in the worst case every element goes into the map.',
  'The brute force alternative would be a nested loop, which is order n squared time but constant space.',
  'For edge cases I would consider an empty array, an array with a single element, and duplicate values that sum to the target.',
  'Hash map lookups are order one on average, so doing that n times gives order n overall.',
].join(' ');

/** Seconds of silence before the candidate speaks. */
const LEAD_SILENCE_S = 22;

async function renderMicWav(): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const aiff = join(TMP, 'mic.aiff');
  const speech = join(TMP, 'speech.wav');
  const wav = join(TMP, 'mic.wav');
  if (existsSync(wav)) return wav;

  await exec('say', ['-v', 'Daniel', '-r', '165', '-o', aiff, SCRIPT]);
  // 48 kHz because Chrome's fake capture device expects a standard rate; the
  // page's own AudioContext downsamples to the 16 kHz the Live API wants.
  await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff,
    '-ar', '48000', '-ac', '1', '-acodec', 'pcm_s16le', speech]);

  /**
   * Prepend lead silence so the interviewer finishes asking the question
   * before candidate speech begins, avoiding premature barge-in interruptions.
   */
  await exec('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-t', String(LEAD_SILENCE_S), '-i', 'anullsrc=r=48000:cl=mono',
    '-i', speech,
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]',
    '-ar', '48000', '-ac', '1', '-acodec', 'pcm_s16le', wav]);

  await rm(aiff, { force: true });
  await rm(speech, { force: true });
  return wav;
}

/* ── page instrumentation ──────────────────────────────────────────────────── */

/**
 * Counts real audio buffers scheduled for playback, and mic chunks captured.
 * Installed before any app code runs so nothing is missed.
 */
const INSTRUMENT = `
  window.__orvia = { played: 0, playedSeconds: 0, micChunks: 0, audioDeltas: 0, errors: [] };
  const origBS = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function () {
    const node = origBS.call(this);
    const origStart = node.start.bind(node);
    node.start = (...a) => {
      window.__orvia.played++;
      if (node.buffer) window.__orvia.playedSeconds += node.buffer.duration;
      return origStart(...a);
    };
    return node;
  };
  const OrigWS = window.WebSocket;
  function WrappedWS(...a) {
    const ws = new OrigWS(...a);
    const origSend = ws.send.bind(ws);
    ws.send = (d) => {
      try { if (typeof d === 'string' && d.includes('audio.chunk')) window.__orvia.micChunks++; } catch {}
      return origSend(d);
    };
    ws.addEventListener('message', (e) => {
      try { if (typeof e.data === 'string' && e.data.includes('audio.delta')) window.__orvia.audioDeltas++; } catch {}
    });
    return ws;
  }
  // The static constants MUST be carried over. Without them the app's
  // readyState === WebSocket.OPEN check compares against undefined and every
  // send is silently dropped, which looks exactly like a hung app.
  WrappedWS.prototype = OrigWS.prototype;
  Object.assign(WrappedWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = WrappedWS;
  window.addEventListener('error', (e) => window.__orvia.errors.push(String(e.message)));
`;

type Probe = { played: number; playedSeconds: number; micChunks: number; audioDeltas: number; errors: string[] };
const probe = (p: Page) => p.evaluate(() => (window as never as { __orvia: Probe }).__orvia);

/* ── main ──────────────────────────────────────────────────────────────────── */

async function main() {
  console.log('\n\x1b[1mOrvia — browser end-to-end (real mic, real UI)\x1b[0m');

  phase('0. preflight');

  await preflight(API);

  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  check('API is up', !!health?.ok, API);
  const webUp = await fetch(WEB).then((r) => r.ok).catch(() => false);
  check('web dev server is up', webUp, WEB);
  if (!health?.ok || !webUp) return report();

  const micWav = await renderMicWav();
  check('microphone audio rendered', existsSync(micWav), micWav);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: !HEADED,
      args: [
        '--use-fake-ui-for-media-stream',       // auto-grant the mic prompt
        '--use-fake-device-for-media-stream',
        // %noloop matters: without it Chrome repeats the file forever, the
        // candidate never stops talking, and barge-in cuts the interviewer off
        // the instant it starts — so it never gets to say anything.
        `--use-file-for-fake-audio-capture=${micWav}%noloop`,
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(INSTRUMENT);
    const page = await ctx.newPage();

    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('401') && !m.text().includes('favicon')) {
        consoleErrors.push(m.text());
      }
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    // On any timeout, print what the user would actually be looking at —
    // guessing from a red cross wastes far more time than 20 lines of text.
    dumpPage = async () => {
      try {
        const body = (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, 700);
        console.log(`      \x1b[2m--- page shows ---\n      ${body.split('\n').join('\n      ')}\n      ---\x1b[0m`);
        if (consoleErrors.length) {
          console.log(`      \x1b[2mconsole: ${consoleErrors.slice(-3).join(' | ').slice(0, 300)}\x1b[0m`);
        }
      } catch { /* page may be gone */ }
      dumpPage = null; // once is enough
    };

    await runSuite(page, consoleErrors);
  } finally {
    await browser?.close();
  }
  report();
}

async function runSuite(page: Page, consoleErrors: string[]) {
  const email = `browser+${process.pid}@orvia.local`;
  const password = 'browser-e2e-password';

  /* ── 1. sign up ─────────────────────────────────────────────────────────── */
  phase('1. account');
  await page.goto(WEB, { waitUntil: 'networkidle' });
  check('sign-in screen renders', await page.getByRole('heading', { name: 'Orvia' }).isVisible());

  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.locator('#name').fill('Browser Runner');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  check('signed in and shell loaded',
    await until(() => page.getByRole('link', { name: 'Progress' }).isVisible(), 15_000, 'nav'),
    email);

  /* ── 2. profile persistence ─────────────────────────────────────────────── */
  phase('2. profile');
  await page.getByRole('link', { name: 'Profile' }).click();
  const EXP = 'Led the billing migration off the monolith; cut p99 checkout latency from 1.4s to 380ms.';
  await page.locator('#exp, textarea').first().fill(EXP);
  await page.locator('#role').fill('Senior Backend Engineer');
  await page.locator('#role').blur();
  check('profile saved',
    await until(() => page.getByText('Saved', { exact: true }).isVisible(), 10_000, 'save confirmation'));

  await page.reload({ waitUntil: 'networkidle' });
  const reloaded = await page.locator('textarea').first().inputValue();
  check('profile survives a reload', reloaded.includes('billing migration'), `${reloaded.length} chars`);

  /* ── 3. setup panel ─────────────────────────────────────────────────────── */
  phase('3. setup');
  await page.getByRole('link', { name: 'Interview' }).click();
  // One of each KIND of collection: a fetched public list, a company list
  // curated in the repo, and the derived "all". They reach the browser by the
  // same DB-driven route, so a missing one means the route, not the label.
  check('question collections listed',
    await until(async () => (await page.getByText('NeetCode 150').count()) > 0 &&
                            (await page.getByText('Top Amazon Questions').count()) > 0 &&
                            (await page.getByText('All questions').count()) > 0, 10_000, 'collections'));

  const qCount = await page.locator('button', { hasText: /Two Sum/ }).count();
  check('question bank rendered', qCount > 0, `"Two Sum" found`);

  // The rail holds the SECTIONS; the questions stay in the main pane where
  // their titles are readable — 37% of them truncate at rail width.
  /* The rail is one control now: "Lists" for DSA, "Topics" for concepts,
     "Competencies" for behavioural — so it is addressed by the heading it
     actually carries, and this suite stopped finding it when that changed. */
  const rail = page.getByRole('complementary', { name: 'Lists', exact: true });
  check('collection rail present', await rail.isVisible());
  check('lists live in the rail',
    (await rail.getByText('NeetCode 150').count()) > 0 &&
    (await rail.getByText('Top Google Questions').count()) > 0 &&
    (await rail.getByText('Top Amazon Questions').count()) > 0 &&
    (await rail.getByText('All questions').count()) > 0);
  check('switching list reloads the questions', await (async () => {
    await rail.getByText('Top Google Questions').click();
    return until(async () =>
      (await page.locator('button', { hasText: /Shortest Path in a Grid/ }).count()) > 0, 10_000, 'google list');
  })(), 'Google list loaded');
  await rail.getByText('NeetCode 150').click();
  await sleep(400);

  // A long title must render in full rather than being clipped.
  check('long question titles are not truncated', await page.evaluate(() => {
    const el = [...document.querySelectorAll('button span')]
      .find((n) => n.textContent === 'Construct Binary Tree from Preorder and Inorder Traversal');
    return !!el && el.scrollWidth <= el.clientWidth + 1;
  }), '58-char title fits');

  await page.locator('button', { hasText: /Two Sum/ }).first().click();
  check('picked questions appear in order',
    await until(() => page.getByText('Asked in this order', { exact: false }).isVisible(), 6000, 'order list'));

  await page.getByPlaceholder('Search by title or topic…').fill('trapping');
  await sleep(400);
  const filtered = await page.locator('button', { hasText: /Trapping Rain Water/ }).count();
  check('search filters the list', filtered > 0, 'searched "trapping"');
  await page.getByPlaceholder('Search by title or topic…').fill('');
  await sleep(300);

  /* Every mode must at least render its own inputs.

     Addressed by the SHORT label, which is what the tab row carries: seven
     tabs reading "Experience-Based Interview" is a paragraph, not a tab row,
     and this suite silently stopped finding them when that changed. */
  for (const [mode, probeText] of [
    ['Job description', 'Job description'],
    ['Experience', 'Your experience'],
    ['System design', 'Problem'],
    ['Concepts', 'Depth'],
    ['Behavioural', 'Your experience'],
    ['HR & salary', 'Scenario'],
  ] as const) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await sleep(250);
    check(`${mode} renders`, await page.getByText(probeText, { exact: false }).first().isVisible());
  }

  await page.getByRole('button', { name: 'Experience', exact: true }).click();
  await sleep(300);
  const prefilled = await page.locator('#exp').inputValue();
  check('experience mode pre-fills from the profile', prefilled.includes('billing migration'),
    'no re-pasting needed');

  check('system design lists its problems', await (async () => {
    await page.getByRole('button', { name: 'System design', exact: true }).click();
    await sleep(500);
    return (await page.getByText('Design Instagram Newsfeed').count()) > 0;
  })(), '10 problems seeded');
  check('picking a system design problem shows its prompt', await (async () => {
    await page.locator('button', { hasText: /Design Rate Limiter/ }).first().click();
    return until(() => page.getByText('rate limiter that works', { exact: false }).isVisible(), 6000, 'prompt');
  })());

  /* ── 3b. "Surprise me", in each mode that has one ──────────────────────── */
  phase('3b. the random draw');

  /**
   * The draw is one implementation behind three panels, so what is checked
   * here is that each panel is WIRED to it: the button exists, it draws from a
   * non-empty pool, and what it hands you lands in that mode's own selection.
   * The rules themselves are pinned offline by `pnpm test:practice` — they do
   * not need a browser and a microphone to be proved.
   */
  const surpriseBtn = () => page.getByRole('button', { name: 'Surprise me' });

  await page.getByRole('button', { name: 'DSA', exact: true }).click();
  await sleep(400);
  check('DSA offers a random draw', await surpriseBtn().isVisible());
  check('and says how many it can draw from',
    await page.getByText(/\d+ to draw from/).first().isVisible());
  const beforeDraw = await page.locator('ol li').count();
  await surpriseBtn().click();
  check('drawing adds a question to the round',
    await until(async () => (await page.locator('ol li').count()) > beforeDraw, 6000, 'drawn question'),
    `${beforeDraw} → ${await page.locator('ol li').count()}`);
  check('and announces what it assigned',
    await page.getByText('Assigned', { exact: false }).first().isVisible());

  // The rules panel is the same component in every mode; opened once here.
  await page.getByRole('button', { name: /^Rules/ }).click();
  check('the rules open with a difficulty filter',
    await until(() => page.getByRole('button', { name: 'Medium', exact: true }).isVisible(), 5000, 'rules'));
  check('and the outcome rule, which only exists where a report can say',
    await page.getByText('Keep asking until I actually get it right').isVisible());
  await page.getByRole('button', { name: 'Hide rules' }).click();

  await page.getByRole('button', { name: 'Concepts', exact: true }).click();
  await sleep(500);
  check('the concepts rail lists topics with their counts',
    await until(async () =>
      (await page.getByText('Node.js').count()) > 0 && (await page.getByText('Kafka', { exact: false }).count()) > 0,
      8000, 'concept topics'));
  /* The complaint that started this: six questions a topic is three rounds and
     a reset. The rail reports the count the API returned, so this is the
     number a person actually sees before choosing a topic. */
  check('a topic carries enough questions to be worth drawing from',
    await page.evaluate(() => {
      const counts = [...document.querySelectorAll('aside button')]
        .map((b) => Number(/(\d+)\s+questions/.exec(b.textContent ?? '')?.[1] ?? 0))
        .filter((n) => n > 0);
      return counts.length >= 8 && Math.min(...counts) >= 10;
    }), 'every topic ≥ 10');

  check('concepts offers a random draw', await surpriseBtn().isVisible());
  await surpriseBtn().click();
  check('drawing a concept question adds it to the round',
    await until(() => page.getByText('Asked in this order', { exact: false }).isVisible(), 6000, 'concept order list'));
  check('and names the topic it came from, which need not be the one on screen',
    await page.getByText('Assigned', { exact: false }).first().isVisible());

  await page.getByRole('button', { name: 'System design', exact: true }).click();
  await sleep(500);
  check('system design offers a random draw', await surpriseBtn().isVisible());
  await surpriseBtn().click();
  check('drawing a design problem selects one',
    await until(() => page.getByText('Assigned', { exact: false }).first().isVisible(), 6000, 'assigned design problem'),
    (await page.getByText('Assigned', { exact: false }).first().textContent().catch(() => ''))?.slice(0, 60));
  await page.getByRole('button', { name: /^Rules/ }).click();
  await sleep(300);
  check('its rules filter on level, not difficulty',
    (await page.getByRole('button', { name: 'Staff', exact: true }).count()) > 0 &&
      (await page.getByRole('button', { name: 'Medium', exact: true }).count()) === 0);
  check('and offer no outcome rule, because no report will ever say',
    (await page.getByText('Keep asking until I actually get it right').count()) === 0,
    'a design round is scored by phase');
  await page.getByRole('button', { name: 'Hide rules' }).click();

  /* ── 4. the interview, with a real microphone ───────────────────────────── */
  phase('4. live interview (real mic, real playback)');
  await page.getByRole('button', { name: 'DSA', exact: true }).click();
  await sleep(500);
  if (!(await page.getByText('Asked in this order', { exact: false }).isVisible().catch(() => false))) {
    await page.locator('button', { hasText: /Two Sum/ }).first().click();
  }

  // Range inputs ignore fill(); set the value and fire the event React listens to.
  await page.locator('#dur').evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, '5');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Start interview' }).click();

  check('interview room opened',
    await until(() => page.getByText('End & get report').isVisible(), 30_000, 'live room'));

  check('microphone is capturing',
    await until(async () => (await probe(page)).micChunks > 20, 25_000, 'mic chunks'),
    `${(await probe(page)).micChunks} chunks sent`);

  // Two separate facts. Whether the audio ARRIVED is a product concern and is
  // asserted. Whether it audibly PLAYED depends on an output device, which a
  // headless browser does not have, so that is reported and not failed on.
  const gotAudio = await until(async () => (await probe(page)).audioDeltas > 20, 60_000, 'interviewer audio');
  const a = await probe(page);
  check('interviewer audio reached the browser', gotAudio,
    `${a.audioDeltas} PCM frames received`);
  check('audio was scheduled for playback', a.played > 0,
    `${a.played} buffers queued${a.playedSeconds < 0.1 ? ' (headless has no output device, so nothing is audible)' : `, ${a.playedSeconds.toFixed(1)}s`}`);

  check('interviewer transcript rendered',
    await until(async () => (await page.getByText('Interviewer', { exact: true }).count()) > 0, 25_000, 'ai transcript'));

  /* code editor */
  const hasEditor = await page.locator('.cm-content').count() > 0;
  check('code editor is present', hasEditor);
  if (!hasEditor) {
    check('editor accepts typing', false, 'skipped — no editor on screen');
    check('editor sync indicator reaches "seen"', false, 'skipped');
    check('editor language switches', false, 'skipped');
    check('language switch loads that language\'s starter', false, 'skipped');
    check('language switch back restores the code', false, 'skipped');
  } else {
  await page.locator('.cm-content').click();
  await page.keyboard.type('def two_sum(nums, target):\n    seen = {}\n');
  check('editor accepts typing', (await page.locator('.cm-content').innerText()).includes('two_sum'));
  check('editor sync indicator reaches "seen"',
    await until(() => page.getByText('Interviewer can see this').isVisible(), 15_000, 'code push'),
    'debounced push confirmed');

  const lang = page.locator('select').first();
  await lang.selectOption('javascript');
  check('editor language switches', (await lang.inputValue()) === 'javascript');

  /**
   * Switching language must present that language's starter rather than leaving
   * code from the previous language in the editor buffer.
   */
  const afterSwitch = await until(
    async () => !(await page.locator('.cm-content').innerText()).includes('seen = {}'),
    5_000,
    'buffer swap',
  );
  check("language switch loads that language's starter", afterSwitch,
    afterSwitch ? 'python body gone' : 'python body still in the editor');

  // And the work is not destroyed by the switch — the per-language buffer is
  // what lets the swap above be unconditional in the first place.
  await lang.selectOption('python');
  check('language switch back restores the code',
    await until(
      async () => (await page.locator('.cm-content').innerText()).includes('two_sum'),
      5_000,
      'buffer restore',
    ));
  }

  check('your speech was transcribed',
    await until(async () => (await page.getByText('You', { exact: true }).count()) > 0, 90_000, 'user transcript'));

  /* ── 5. report card ────────────────────────────────────────────────────── */
  phase('5. report card');
  await page.getByRole('button', { name: 'End & get report' }).click();
  check('round-complete screen shown',
    await until(() => page.getByText('Round complete').isVisible(), 25_000, 'end screen'));

  // Captured for the audio check below, which cannot read it from the URL.
  const sessionIdForAudio = await page.evaluate(async () => {
    const r = await fetch('/api/sessions', { credentials: 'include' });
    const rows = await r.json();
    return rows[0]?.id ?? '';
  });

  const reportReady = await until(
    () => page.getByText('Report card').isVisible(), 300_000, 'the report (evaluator runs on the whole recording)');
  check('report card rendered', reportReady);

  if (reportReady) {
    check('overall score shown', await page.getByText('/ 100').isVisible());
    check('three ranked fixes shown', await page.getByText('Fix these three next time').isVisible());
    check('measured metrics shown', await page.getByText('Measured', { exact: true }).isVisible());
    check('delivery dimensions shown', await page.getByText('Communication and presence').isVisible());
    check('per-question section shown', await page.getByText('Question by question').isVisible());

    // The accordion is the only route to the ideal answers, so it must open.
    const firstQ = page.locator('button', { hasText: /\/10/ }).first();
    if (await firstQ.count()) {
      // The first question is expanded by default, so only click when it is
      // actually closed — otherwise the click collapses it.
      if (!(await page.getByText('What a strong answer looks like').isVisible().catch(() => false))) {
        await firstQ.click();
      }
      check('question expands to show the ideal answer',
        await until(() => page.getByText('What a strong answer looks like').isVisible(), 8000, 'accordion'));
    }
    check('evidence quotes rendered', (await page.locator('blockquote').count()) > 0,
      `${await page.locator('blockquote').count()} quotes`);

    /* round metadata — what was actually run */
    check('round details recorded', await page.getByText('Round details').isVisible());
    for (const field of ['Interviewer voice', 'Bar', 'Manner', 'Length', 'Mode']) {
      check(`  metadata: ${field}`, await page.getByText(field, { exact: true }).first().isVisible());
    }

    /* your code beside a working solution */
    const gotCode = await until(async () => (await page.locator('pre code').count()) > 0, 15_000, 'code blocks');
    check('code comparison rendered', gotCode,
      `${await page.locator('pre code').count()} code block(s) — your code and/or a model solution`);
    if (gotCode) {
      check('  your own code is shown', await page.getByText('What you wrote', { exact: false }).first().isVisible());
      check('  a working solution is shown beside it',
        await page.getByText('A working solution', { exact: false }).first().isVisible());
    }

    /* recording playback — the report can now be heard, not just read */
    /**
     * By LABEL, not by text. The `RecordingPlayer` rewrite moved "Play the
     * whole round" onto the play button's `aria-label` — it is an icon button,
     * so the string is no longer rendered as visible text and `getByText`
     * could never match it again. The control is still there; only the check
     * was stale.
     */
    // Probed by HEAD after the report renders, and the round has usually just
    // been archived, so the probe waits on an R2 restore (9s measured).
    check('recording playback offered',
      await until(() => page.getByLabel('Play the whole round').isVisible(), 30_000, 'recording restore'));
    const hearIt = await page.getByText('Hear it').count();
    check('evidence quotes are playable', hearIt > 0, `${hearIt} quotes with a play control`);
    // The end screen is at "/", so the id has to come from the report itself
    // rather than the URL.
    check('audio endpoint serves the recording', await page.evaluate(async (sid) => {
      const r = await fetch(`/api/sessions/${sid}/audio`, {
        method: 'GET', headers: { Range: 'bytes=0-1023' }, credentials: 'include',
      });
      return r.status === 206 || r.status === 200;
    }, sessionIdForAudio).catch(() => false));

    /* ── the coach ──────────────────────────────────────────────────────── */
    phase('5b. voice coach');
    check('coach is offered on the report', await page.getByText('Talk it through with a coach').isVisible());

    const before = (await probe(page)).played;
    await page.getByRole('button', { name: 'Start coaching' }).click();

    check('coach session connects',
      await until(() => page.getByRole('button', { name: 'End', exact: true }).isVisible(), 45_000, 'coach room'));

    // The coach is primed with the whole recording, so its first reply takes a
    // while — it is listening to the round before it says anything.
    check('coach speaks back',
      await until(async () => (await probe(page)).audioDeltas > 40 || (await probe(page)).played > before + 5,
        120_000, 'coach audio'),
      `${(await probe(page)).played - before} buffers after starting the coach`);

    check('coach transcript appears',
      await until(async () => (await page.getByText('Coach', { exact: true }).count()) > 0, 60_000, 'coach transcript'));

    await page.getByRole('button', { name: 'End', exact: true }).click();
    check('coach session can be ended and restarted',
      await until(async () =>
        (await page.getByText('Talk it through with a coach').isVisible()) &&
        (await page.getByRole('button', { name: /Start again|Start coaching/ }).isVisible()),
        15_000, 'coach reset'));
  }

  /* ── 6. history and the saved report ───────────────────────────────────── */
  phase('6. history and progress');
  await page.getByRole('link', { name: 'History' }).click();
  check('history lists the round',
    await until(async () => (await page.getByText('DSA Interview').count()) > 0, 12_000, 'history row'));

  await page.getByText('DSA Interview').first().click();
  check('saved report opens from history',
    await until(() => page.getByText('Report card').isVisible(), 25_000, 'session report page'));
  check('transcript can be revealed',
    await (async () => {
      const t = page.getByRole('button', { name: 'Show full transcript' });
      if (!(await t.count())) return false;
      await t.click();
      return until(async () => (await page.getByText('Interviewer', { exact: true }).count()) > 0, 6000, 'transcript');
    })());

  /* A fix carried into the next rounds, and the moments offered for a retry. */
  const carry = page.getByRole('button', { name: 'Work on this' });
  check('each of the report\'s fixes can be carried into the next rounds',
    await until(async () => (await carry.count()) > 0, 10_000, 'commit buttons'), `${await carry.count()} fixes`);
  const carriedText = (await carry.count())
    ? ((await carry.first().locator('xpath=..').locator('span').nth(1).innerText().catch(() => '')) || '')
    : '';
  if (await carry.count()) await carry.first().click();
  check('...and the report says so once one is',
    await until(() => page.getByText('Working on it').first().isVisible(), 10_000, 'committed'));
  check('the report offers its weak moments for a retry, or says why there are none',
    await until(async () => (await page.getByText('Practise the moments that cost you').count()) > 0, 10_000, 'moments panel'));

  phase('6a. the plan');
  // Scoped to the nav: the report's fixes panel links to the plan too.
  await page.locator('nav').getByRole('link', { name: 'Plan', exact: true }).click();
  check('the plan page renders its sections',
    await until(async () =>
      (await page.getByRole('heading', { name: 'Readiness' }).isVisible()) &&
      (await page.getByRole('heading', { name: 'This week' }).isVisible()) &&
      (await page.getByRole('heading', { name: 'Onsite loops' }).isVisible()), 15_000, 'plan'));
  check('the fix committed from the report is on the plan',
    !carriedText || await until(() => page.getByText(carriedText).first().isVisible(), 8000, 'commitment on plan'),
    carriedText.slice(0, 60));
  check('readiness reflects the round just run', await page.getByText(/Building|Close|Ready/).first().isVisible());

  await page.getByRole('link', { name: 'Progress' }).click();
  check('progress page renders', await until(() => page.getByText('Overall score').isVisible(), 12_000, 'charts'));
  check('account mentor offered on progress', await page.getByText('Ask your mentor').first().isVisible());
  check('charts drawn as SVG', (await page.locator('svg').count()) > 2,
    `${await page.locator('svg').count()} svg elements`);
  check('table view present', await page.getByText('All rounds').isVisible());
  check('no chart label overflows its card', await page.evaluate(() => {
    // The clipped-endpoint-label bug, asserted rather than eyeballed.
    return [...document.querySelectorAll('svg')].every((s) => {
      const sw = s.getBoundingClientRect().width;
      return [...s.querySelectorAll('text')].every((t) => {
        const r = t.getBoundingClientRect();
        const sr = s.getBoundingClientRect();
        return r.right <= sr.left + sw + 1;
      });
    });
  }));

  /* ── 7. theme + sign out ───────────────────────────────────────────────── */
  /* ── 6b. a round with more than one question ───────────────────────────── */

  /** Verify that multi-question rounds advance the displayed question and starter code as the interviewer moves between questions. */
  phase('6b. multi-question round');
  await page.getByRole('link', { name: 'Interview' }).click();
  await page.getByRole('button', { name: 'DSA', exact: true }).click();
  await sleep(600);

  const pick = async (title: RegExp) => {
    const b = page.locator('button', { hasText: title }).first();
    await b.click();
    await sleep(250);
  };
  await pick(/Two Sum/);
  await pick(/Valid Parentheses/);

  await page.locator('#dur').evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, '5');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Start interview' }).click();
  const opened = await until(() => page.getByText('End & get report').isVisible(), 30_000, 'live room');
  check('two-question round opens', opened);

  if (opened) {
    const strip = page.getByRole('region', { name: 'What this round is working on' });
    check('the live room shows the fix this round is carrying',
      await until(() => strip.isVisible(), 10_000, 'focus strip') &&
        (!carriedText || (await strip.innerText()).includes(carriedText.slice(0, 30))),
      (await strip.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 80));

    const tabs = page.getByRole('tab');
    check('every question gets a tab',
      await until(async () => (await tabs.count()) === 2, 15_000, 'question tabs'),
      `${await tabs.count()} tab(s)`);

    // The heading must say WHICH question, not just the round's first one.
    check('the heading shows the position in the round',
      await page.getByText('1/2', { exact: false }).first().isVisible());
    check('the heading names question one', await tabs.nth(0).getAttribute('aria-selected') === 'true');

    const editorText = () => page.locator('.cm-content').first().innerText();
    const q1Code = await editorText();
    check('the editor opens on a skeleton', q1Code.trim().length > 0, `${q1Code.trim().length} chars`);

    /* switch to question two ------------------------------------------------ */
    await tabs.nth(1).click();
    const switched = await until(async () =>
      (await tabs.nth(1).getAttribute('aria-selected')) === 'true', 10_000, 'tab 2 selected');
    check('clicking a tab switches the round to that question', switched);
    check('the heading follows the switch',
      await page.getByText('2/2', { exact: false }).first().isVisible());

    const q2Code = await until(async () => (await editorText()) !== q1Code, 10_000, 'editor swap');
    check("the editor loads the NEW question's starter code", q2Code,
      q2Code ? `"${(await editorText()).trim().slice(0, 40)}…"` : 'editor did not change');

    /* work on question two must survive going back and forth ---------------- */
    const marker = '# working on question two';
    await page.locator('.cm-content').first().click();
    await page.keyboard.type(marker);
    await sleep(400);
    check('typing lands in the question-two buffer',
      (await editorText()).includes(marker));

    await tabs.nth(0).click();
    await until(async () => (await tabs.nth(0).getAttribute('aria-selected')) === 'true', 10_000, 'back to tab 1');
    await sleep(500);
    check('going back does not carry question two\'s work with it',
      !(await editorText()).includes(marker));

    await tabs.nth(1).click();
    await until(async () => (await tabs.nth(1).getAttribute('aria-selected')) === 'true', 10_000, 'tab 2 again');
    check('returning to a question restores what was written there',
      await until(async () => (await editorText()).includes(marker), 8000, 'restored buffer'));

    await page.getByRole('button', { name: 'End & get report' }).click();
    /** Verify that the round terminates cleanly and presents status messaging on the end screen. */
    check('the multi-question round ends cleanly',
      await until(() =>
        page.getByText(/Report|Evaluating|Scoring|building your report|not scored|too short|enough conversation/i)
          .first().isVisible(),
        45_000, 'end screen'));
  }

  /* ── 6c. phone width ───────────────────────────────────────────────────────
     Assert that pages do not overflow horizontally at mobile widths, excluding
     elements inside deliberately scrollable containers (navs, tabs, code blocks). */
  phase('6c. phone width');
  const PHONE = { width: 390, height: 844 };
  await page.setViewportSize(PHONE);

  /**
   * Find elements escaping viewport width outside scrollers. Uses inline anonymous
   * functions to avoid esbuild `keepNames` helpers missing in the browser context.
   */
  const escapees = () =>
    page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out: string[] = [];
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        if (r.right <= vw + 1 && r.left >= -1) return;
        let scrolls = false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth + 1) {
            scrolls = true;
            break;
          }
        }
        if (!scrolls) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
      });
      return { docWidth: document.documentElement.scrollWidth, viewport: vw, escapees: out };
    });

  // `/feed` is in this list ahead of the others in spirit: it is the one page
  // designed phone-first, and a card whose rating buttons sit outside the
  // screen is the failure that makes the whole feature unusable.
  for (const path of ['/', '/plan', '/feed', '/study', '/study?mode=hr', '/study?mode=behavioural', ...(HAS_PLAYBOOK ? ['/playbook'] : []), '/progress', '/history', '/profile']) {
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
    await sleep(600);
    const r = await escapees();
    check(`${path} does not scroll sideways at ${PHONE.width}px`,
      r.docWidth <= r.viewport + 1, `doc ${r.docWidth}px`);
    check(`${path} keeps every element inside the screen`,
      r.escapees.length === 0, r.escapees.slice(0, 2).join(' | ') || 'clean');
  }

  // The chart-label check from phase 6, re-run where the cards are narrowest.
  await page.goto(`${WEB}/progress`, { waitUntil: 'networkidle' });
  await sleep(600);
  check('no chart label overflows its card on a phone', await page.evaluate(() =>
    [...document.querySelectorAll('svg')].every((s) => {
      const sr = s.getBoundingClientRect();
      return [...s.querySelectorAll('text')].every((t) => t.getBoundingClientRect().right <= sr.right + 1);
    })));

  /* The nav is the one piece of chrome that MUST still be reachable: it is how
     you leave the page, and it is the thing that wraps to a second row here. */
  check('every nav link stays tappable at phone width', await (async () => {
    for (const name of ['Interview', 'Plan', ...(HAS_PLAYBOOK ? ['Playbook'] : []), 'Progress', 'History', 'Profile']) {
      const link = page.locator('nav').getByRole('link', { name, exact: true });
      if (!(await link.isVisible())) return false;
      const box = await link.boundingBox();
      if (!box || box.height < 24) return false;
    }
    return true;
  })());

  // Back to the desktop viewport the remaining phases were written against.
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);

  phase('7. theme and session');
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await page.locator('header').getByRole('button', { name: /^dark$/i }).click();
  await sleep(400);
  check('dark theme applies',
    (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.locator('header').getByRole('button', { name: /^light$/i }).click();
  await sleep(400);
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('theme actually repaints the page', darkBg !== lightBg, `${darkBg} → ${lightBg}`);

  await page.getByRole('button', { name: /sign out/i }).click();
  check('sign out returns to the sign-in screen',
    await until(() => page.getByRole('button', { name: 'Sign in' }).isVisible(), 12_000, 'auth screen'));

  await page.goto(`${WEB}/progress`, { waitUntil: 'networkidle' });
  check('signed-out users cannot reach the app',
    await page.getByRole('button', { name: 'Sign in' }).isVisible());

  /* ── 8. console hygiene ────────────────────────────────────────────────── */
  phase('8. runtime errors');
  const pageErrors = (await probe(page).catch(() => ({ errors: [] as string[] }))).errors ?? [];
  const all = [...consoleErrors, ...pageErrors];
  check('no uncaught errors during the whole run', all.length === 0,
    all.length ? all.slice(0, 3).join(' | ').slice(0, 200) : 'clean');
}

function report(): never {
  console.log(`\n${'─'.repeat(64)}`);
  if (!failures.length) {
    console.log(`\x1b[32m\x1b[1mALL ${passed} BROWSER CHECKS PASSED\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m${failures.length} FAILED\x1b[0m, ${passed} passed`);
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  console.log('');
  process.exit(1);
}

void main().catch((e) => {
  console.error('\x1b[31mharness crashed:\x1b[0m', e);
  process.exit(1);
});
