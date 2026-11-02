# Orvia

**Practise the interview, not just the questions.**

Orvia is an AI interview-preparation platform built around realistic spoken
rounds. An AI interviewer talks to you, you answer out loud, and **nothing is
judged until the round is over** — then a separate evaluator grades both what
you said and how you said it.

## What it does

- **Live voice interviews.** A real-time interviewer on the Gemini Live API runs
  a full spoken round: it asks, listens and probes deeper, and like a real
  interviewer it never hints, helps or praises. Coding and system design rounds
  put a shared editor on screen that the interviewer reads as you work.
- **Seven kinds of round** — DSA, system design, core concepts, a round built
  from a job description you paste, a deep-dive into your own experience,
  behavioural, and HR including salary negotiation.
- **Evidence-based reports.** The evaluator hears the recording as well as the
  transcript, so it scores delivery — hesitation, fillers, pace, response
  latency — and not only content. Every delivery score quotes what you actually
  said, and whether your code works is checked before the rubric runs.
- **A coach and a mentor.** After a round you can talk it through with a coach
  that has heard that recording. The mentor sees every round, report and trend
  you have, remembers your goals, and helps you decide what to work on next.
- **A learning feed instead of doomscrolling.** A phone-first, one-card-at-a-time
  feed of lessons, patterns, quizzes and timed drills, with spaced-repetition
  review, streaks and optional narration. It bends towards your weak topics,
  and it **ends** rather than looping to keep you scrolling.
- **A plan towards the job you want.** Retry the exact moments a report flagged,
  commit to fixes and see whether they stick, run full onsite loops judged by a
  hiring-committee rule, practise in a company's interviewer style, and count
  down to your interview date with readiness per mode.
- **History and progress.** Every round keeps its transcript, recording, report
  and scores, with trends per dimension over time.

Orvia covers software engineering roles today. The core engine — live
interviewing, audio-aware evaluation, coaching and planning — does not depend
on the role; the question banks and the rubric do, and those are what would
change to take it to finance, product or other fields.

---

## Why it is split in two

The interviewer and the evaluator are deliberately different systems with
different models, different latency budgets and different information.

| | Interviewer | Evaluator |
|---|---|---|
| When | During the round | After the round |
| Model | `gemini-3.8-live` | `gemini-3.6-flash` |
| Latency budget | Sub-second | Minutes |
| Sees | Only what has happened so far | The whole session, including the audio |
| Job | Ask, listen, probe | Score, explain, coach |

The interviewer is explicitly forbidden from evaluating, hinting or praising.
You cannot practise being assessed by something that is helping you.

## The decision everything else depends on

**The candidate's raw microphone audio is recorded and handed to the evaluator.**

Confidence, hesitation, filler density, the wobble in a voice when someone is
guessing — these exist in the waveform. A transcript, however verbatim, cannot
carry them. Without the audio the evaluator can only grade prose and will
invent plausible-sounding delivery feedback rather than observe it.

Two things follow:

- `inputAudioTranscription` runs in **`VERBATIM`** mode, so fillers, stutters
  and false starts survive. `SMART` mode would strip exactly the signal being
  measured.
- `enableAffectiveDialog` is deliberately **off**. It makes the model soften
  when it hears nervousness, which is both unrealistic and would contaminate
  the signal the evaluator scores.

### Why transcription happens twice

`custom_vocabulary` and word timestamps are **mutually exclusive** in Gemini —
on the Live API *and* on `gemini-3.5-transcribe`. The capability is therefore
split across the two passes:

| | Live pass | Offline pass (step 2) |
|---|---|---|
| Model | `gemini-3.1-flash-live-preview` | `gemini-3.5-transcribe` |
| Gets | vocabulary biasing | word timestamps + diarization |
| For | the on-screen transcript | the delivery metrics |

Measured on this repo: `wordTimestamp: true` returns **zero** word objects on
the live model, so it costs accuracy and buys nothing there. The offline pass
does return them (67 word offsets on a 26s clip) and is audibly more accurate —
it heard *"Sure. My approach"* where the live pass heard *"Show my approach"*.

---

## Architecture

```
Browser (React + Vite)
 ├─ mic ─► AudioWorklet ─► Int16 PCM @16k ─┐
 │                                          ├──► WS /ws/interview ──► NestJS
 │  speaker ◄── PCM @24k ◄──────────────────┘                          │
 └─ code editor / scratchpad ──► debounced context push                │
                                                                        ▼
                                          ┌──────────────────────────────────┐
                                          │ NestJS API (holds the API key)   │
                                          │  • Live API socket + resumption  │
                                          │  • transcript accumulation       │
                                          │  • candidate audio ─► WAV        │
                                          └──────────────────────────────────┘
                                                    │              │
                                            Postgres (Drizzle)   data/audio/*.wav
                                                    │              │
                                                    └──────┬───────┘
                                                           ▼
                                              Evaluator
                                              audio + verbatim transcript
                                              + deterministic metrics
                                                           │
                                                     report card
```

The browser never talks to Gemini. The key, the upstream socket, the transcript
and the recording all stay server side.

### Models

Pinned in one place — `packages/shared/src/models.ts`. Several are `-preview`
and Google rotates them; when one 404s, that file is the only thing you touch.

| Role | Model |
|---|---|
| Interviewer, coach and mentor (realtime audio) | `gemini-3.8-live` |
| Fallback interviewers, in order | `gemini-3.1-flash-live-preview`, then `gemini-2.5-flash-native-audio-preview-12-2025` |
| Post-round re-transcription | `gemini-3.5-transcribe-live` |
| Evaluator | `gemini-3.6-flash`, stepping down to the Flash Lite models on quota |
| JD / experience parsing | `gemini-3.6-flash` |
| Feed narration (`speech:build`) | `gemini-3.1-flash-live-preview` |

### Monorepo

```
apps/
  api/         NestJS 12 — WS gateway, Live API relay, persistence
  web/         Vite 8 + React 19 + Tailwind 4
packages/
  shared/      model registry, interview modes, WS protocol (zod)
  theme/       design tokens -> generated CSS  (single source of truth)
  db/          Drizzle schema + Postgres client
tools/e2e/     end-to-end harness for the voice loop
```

### Theming

Every colour, radius, font and motion value lives in
**`packages/theme/src/tokens.ts` and nowhere else**.

`pnpm theme:build` compiles it into `theme.css`: raw `--orvia-*` variables per
theme, plus a Tailwind `@theme inline` block that registers utilities pointing
at those variables. `@theme inline` (not plain `@theme`) is what keeps the
`var()` reference in the utility, so switching light/dark re-colours the whole
app without recompiling CSS.

Components only ever use semantic utilities — `bg-surface`, `text-fg-muted`,
`border-border`. No hex value appears anywhere outside `tokens.ts`.

---

## Question banks

| Collection | Count | Source |
|---|---|---|
| NeetCode 150 | 150 | public LeetCode list |
| Top Google Questions | 50 | public LeetCode list |
| Top Amazon Questions | 60 | curated in-repo |
| Top Meta Questions | 57 | curated in-repo |
| Top Microsoft Questions | 48 | curated in-repo |
| Top Apple Questions | 38 | curated in-repo |
| Top Bloomberg Questions | 42 | curated in-repo |
| Top Netflix Questions | 20 | curated in-repo |
| All questions | 246 | derived |

**246 unique questions, 711 links.** A problem in six lists is stored **once**
in `dsa_questions` and linked six times through `question_collections` — which
is why nine collections totalling 465 curated entries cost 246 rows.

Collections themselves are rows in the `collections` table, not constants in
code, so a new category is one entry in the ingest script's `LISTS` and the UI
picks it up automatically.

The company lists are **curated in this repo**
(`apps/api/scripts/data/company-lists.mts`) rather than fetched. LeetCode's own
company tags are premium — `problemsetQuestionListV2` with a `companyFilter`
returns nothing without a paid session — and the alternative, pointing at a
stranger's public list, puts our bank inside someone else's account, where an
edit or a deletion silently shrinks it. `ingest` resolves each committed slug
through the same public per-question query that supplies every statement.

**All questions** is derived, not curated: it is rebuilt from the whole bank on
every ingest, ordered by LeetCode problem number. It is a real collection with
real link rows rather than a special case in the API, so the rail, the picker,
the no-repeat rotation and the per-list cycle marker all treat it as just
another list. It is also the home of problems that belong to no list at all —
`STANDALONE_SLUGS` in the ingest script — which is how "231. Power of Two" is
in the bank without being attributed to any company.

### Paid-only problems

LeetCode serves no statement for a premium problem, so 17 of the bank had only
an invented one. `pnpm scrape:premium` fetches the real thing from NeetCode and
LintCode with a **headless browser** — neither is reachable otherwise:
neetcode.io is a client-rendered app whose data sits behind Firebase auth, and
lintcode.com returns an empty body to a plain fetch. 16 of 17 now carry a
published statement (6 NeetCode, 10 LintCode); `robot-room-cleaner` is on
neither site and remains a model reconstruction, flagged as such by
`from_title_only`.

Every page's own title is checked against LeetCode's before anything is
stored, because a wrong slug renders a *different problem* rather than a 404 —
which would put one problem's statement under another's title. The results are
committed to `apps/api/scripts/data/premium-statements.json`, so the browser
runs once and `seed` stays offline.

Prompts are rewritten to be **read aloud**: LeetCode's statement is cut at the
first `Example:` / `Constraints:` marker and cleaned to prose. This is done
deterministically, with no LLM involved, because the free API tier allows only
20 requests per day per model — a 200-question bank cannot depend on generation
to exist. Reference solutions and complexity notes (evaluator-only) come from a
separate, optional `--enrich` pass that degrades gracefully when quota runs out.

```bash
pnpm --filter @orvia/api seed          # offline, from the committed snapshot
pnpm --filter @orvia/api ingest        # refresh from LeetCode (no quota needed)
pnpm --filter @orvia/api ingest --enrich   # also generate evaluator notes
pnpm --filter @orvia/api export-seed   # snapshot the DB back into the seed file
```

## Accounts

Email plus password, argon2id hashed, with a 30-day httpOnly session cookie.
The same cookie authenticates the WebSocket at upgrade — the browser attaches
it automatically, so no token is ever handled by page JavaScript.

Your profile holds the things you should never have to type twice: experience
and projects, resume text, target role, saved job descriptions, and your
session defaults including **pause tolerance** (`silenceDurationMs`), which is
read server-side per user rather than sent by the client.

## Running it

Prerequisites: Node 24 (`nvm use` reads `.nvmrc`), pnpm 11, a local Postgres, `ffmpeg`
(used for archiving, evaluator audio compression and speech building), and a
[Gemini API key](https://aistudio.google.com/apikey). Some test suites use the
macOS `say` command, and `tools/backup-db.sh` looks for `pg_dump` on PATH and
common macOS install locations.

```bash
pnpm install

cp .env.example apps/api/.env
# then put your key in apps/api/.env

createdb orvia                       # or: psql -c 'create database orvia'
pnpm --filter @orvia/shared build
pnpm --filter @orvia/theme build
pnpm --filter @orvia/db build
DATABASE_URL=postgresql://postgres@localhost:5432/orvia \
  pnpm --filter @orvia/db exec drizzle-kit push
pnpm --filter @orvia/api seed        # 246 questions + 10 system design problems

pnpm dev                             # api on :8787, web on :5173
```

Open http://localhost:5173, pick a mode, and start talking.

### R2 setup

Cloudflare R2 archiving is optional; without it, recordings remain on local disk.
To configure it, set the `R2_*` variables in `apps/api/.env`. Set `R2_ACCOUNT_EMAIL`
to your Cloudflare account email: `pnpm audio:status` refuses to run unless
`wrangler whoami` matches it.

### Tests

The live suites write **real** rounds — sessions, transcripts and recordings —
so they run against a separate database and refuse to start against anything
else. Never run one while `pnpm dev` is up on 8787: the suites connect to
whatever API is on that port. Some suites are offline while others spend live
model quota.

```bash
createdb orvia_test
DATABASE_URL=postgresql://postgres@localhost:5432/orvia_test pnpm db:push
DATABASE_URL=postgresql://postgres@localhost:5432/orvia_test pnpm --filter @orvia/api seed

# The API the suites talk to must point at the test database too
pnpm api:test        # DATABASE_URL=orvia_test, DATA_DIR=./data-test

pnpm test:e2e                          # the pipeline, no browser
pnpm test:browser                      # real Chromium, real mic
pnpm test:resumption                   # a real 14-minute round
pnpm --filter @orvia/api verify:metrics # metrics vs ground truth
```

`test:resumption` is the only one that takes real time, and it is the only one
that proves the app survives a long interview. Every other suite runs for about
75 seconds and therefore never crosses the Live API's ~10 minute connection
recycle. This one deliberately does, and asserts the round is still transcribing
on the far side. Observed sequence:

```
[09:02] go_away   [09:08] go_away   [10:00] reconnecting
[12:11] alive · 10 of your turns · 145 interviewer turns
```

`MINUTES=18 pnpm test:resumption` also crosses the 15-minute audio-session cap,
which is handled by context compression rather than by resumption.

`tools/e2e/guard.ts` refuses to run when the database name does not carry
`test` as its own word or suffix. This is a hard stop rather than a convention, because a convention
already failed: a test run against the real database destroyed a genuine
practice interview and its recording, unrecoverably. Recordings are the one
thing here that cannot be regenerated — you cannot re-record a round you have
already done.

### Backups

```bash
pnpm db:backup                 # dump + tar into backups/, then prune old ones
pnpm db:prune                  # prune only, no dump
RETAIN_DAYS=7 pnpm db:backup   # keep a week instead of the default two days
```

Picks the `pg_dump` matching the running server rather than whatever is first on
PATH, which otherwise fails with a version mismatch. Run it before anything
risky.

Each snapshot is a full copy of every recording, so they add up fast — fourteen
of them reached 3.9GB for 590MB of unique audio. `RETAIN_DAYS` (default 2)
bounds that, counting by day rather than by run, so several backups on one day
all survive. The newest snapshot is never pruned, however old it is.

`test:browser` hands Chrome a WAV file as its capture device, so it drives the
genuine path: getUserMedia, the AudioWorklet, playback, the editor, the report
card, the coach, the charts, theming and the auth guard. It asserts that audio
ARRIVED but only reports whether it audibly played — a headless browser has no
output device, and failing on that would be testing the runner.

`verify:metrics` checks the speech measurements against independent ground
truth: ffmpeg's own silence detection for speaking duration, hand-counted
fillers and words for the rest.

```bash
pnpm test:e2e
```

Drives the real pipeline with no browser: macOS `say` renders candidate speech,
which is streamed at real-time pace through the WebSocket to the Live API, and
the harness asserts that the interviewer speaks first, that the speech is
transcribed, that the model responds to what was actually said, and that the
session, turns and WAV recording are all persisted.

The only untested link is the browser's own microphone and speaker.

---

## Interview modes

| Mode | Input | What the interviewer does |
|---|---|---|
| **DSA** | Pick from the question bank | Demands approach before code, probes complexity claims, reacts to the live editor |
| **Job description** | Paste a JD | Questions drawn from that role's actual competencies |
| **Experience** | Paste your background | Drills your own claims — "what was *your* part in that specifically?" |
| **System design** | A problem + target level | Drives the phase ladder: requirements → estimation → API → data model → HLD → deep dive → trade-offs |
| **Core concepts** | A topic from the concepts bank | Treats a correct definition as the start, then pushes to the mechanism underneath and what it costs |
| **Behavioural** | Questions from the behavioural bank | Demands a real example, then pushes on ownership ("what was *your* part?") and measurement |
| **HR & negotiation** | A scenario from the HR bank, plus your numbers | Plays the other side of the compensation conversation and presses once per beat — it is never told what you earn or want; the evaluator is |

All seven share one realtime pipeline. They differ only in the context injected
into the interviewer's system instruction.

---

## The feed

A round is a deliberate forty minutes. The feed is the other half: a vertical,
one-card-at-a-time scroll built for a phone, for the minutes that would
otherwise go somewhere else.

It draws from four places and interleaves them — roughly two reviews, four new
cards, one bank question and one line from your own reports per eight:

- **The teaching bank** (`apps/api/scripts/data/learning-cards.mts`, committed,
  the only copy). Lessons, recognition patterns — the cue you will actually see
  and the move it calls for — and quizzes that mark themselves. It covers DSA
  patterns, core concepts, system design, Docker and Kubernetes, Redis, Kafka,
  AWS and serverless, identity, real-time systems, LLM and AI engineering, and
  how to tell your own stories at senior level.
- **Drills.** A real bank question, put to you with no answer attached and a
  sixty-second clock, because the gap between knowing something and saying it in
  one minute out loud is what interviews measure. "Do it in a round" opens the
  setup screen with that question already ticked.
- **Recalls.** Problems your own latest report scored `partial` or `unsolved`,
  with the evaluator's reason attached.
- **Fixes.** One line at a time from your last three reports, verbatim, with the
  quote that earned it.

**Listen** turns it hands-free: the feed reads itself aloud and advances on its
own, so a card can be answered out loud while you are walking. Quizzes are asked,
then left silent for a few seconds, then answered; a drill leaves forty-five
seconds to answer before moving on. Code is never dictated.

The narration is **pre-generated** by `pnpm --filter @orvia/api speech:build`,
which reads the committed script aloud through the Live model once and stores
the clips under `apps/api/data/speech`. It takes about thirty seconds a card and
is fully resumable, so it is an overnight job you run once; the feed works
throughout, falling back to the browser's voice for anything not yet generated.
The dedicated TTS models are faster but capped at ten requests a day each on the
free tier, which is why the Live model, with no daily cap, does the batch. Synthesis takes about six seconds a card, so doing
it live would stall every scroll and re-spend quota on audio that never changes.
Generated ahead, it starts instantly, costs nothing to replay, and sounds
identical on every device. Cards drawn from your own reports have no
pre-generated audio — they quote your evaluation — so those fall back to the
browser's own speech synthesis, as does any device before the cache is built.

Two things make it a study tool rather than a slot machine. Rating a card
schedules it: **Knew it** pushes the next sighting out a rung (1, 2, 4, 9, 18,
35 days), **Show again** drops it to the bottom and brings it back within the
hour. And it **ends** — when the page runs out it says so, rather than looping
material you have already rated.

What it shows bends towards what you are bad at: the topics of questions your
rounds did not finish, and the delivery dimensions you score lowest on. The stat
card at the top names them, so the personalisation is legible rather than spooky.

It never shows an answer key. `expectedPoints`, `strongAnswer` and the rest stay
server-side exactly as they do everywhere else — `pnpm --filter @orvia/api
verify:feed` fails if a card ever repeats one.

---

## Practising what the report found

A report is worth what the next round does with it. Four things close that loop.

- **Retry a moment.** Every report lists the questions it scored seven or below
  and the delivery dimensions it scored three or below with a quote, each with
  **Retry this moment**. That starts a short *live* round — five minutes for a
  spoken answer, fifteen for code or design — that puts that one question to you
  again, with what the report said was missing on screen. The interviewer is
  handed the question and nothing about how it went. The drill's own report
  shows before and after on the same scale, whether each weakness was fixed
  (with your words as evidence), and every attempt so far. Retry as often as it
  takes.
- **Commit to a fix.** Any of a report's three fixes, or one in your own words,
  can be carried into your next rounds — three at most. The live room shows them
  while you answer, and the evaluator marks each one `applied`, `partly`,
  `not applied` or `no chance this round`, quoting you. Applied in two rounds in
  a row and it is done.
- **The Plan page.** Your interview date and a countdown; readiness per mode
  from your last three rounds; this week's rounds spread weakest first; a
  weekly recap against last week with your best moment of the week; and
  personal bests, each linked to the round that set it.
- **Onsite loops.** Several rounds back to back — a full onsite, a short loop,
  a startup loop or a final round — judged together by a fixed hiring-committee
  rule: any fail is a no hire, two borderlines lean no.

Rounds can also run in a company's **interviewer style** (Amazon, Google, Meta,
startup), which changes what gets probed and never how it is scored.

A drill is scored after you have read the model answer, so it measures the fix,
not you cold. Drills are therefore kept out of the progress chart, readiness,
the practice rotation, the feed's signals and the mentor's trend.

---

## Status

**Steps 1-2 — the live voice loop, accounts and the question banks.** Done.

- Bidirectional audio with barge-in
- Verbatim transcription with technical-vocabulary biasing
- All seven interview modes, server side
- Session, turns and context snapshots in Postgres
- Candidate audio recorded to WAV
- Session resumption + context compression, so long rounds survive
- Full UI: sign-in, setup, split-pane live room, transcript, history, profile
- **DSA and system design rounds run voice-left / editor-right**, with the
  editor's contents pushed to the interviewer on a 2.5s debounce so it reacts
  to settled thinking rather than every keystroke
- CodeMirror editor with Python, JavaScript, TypeScript, Java, C++ and Go

**The evaluator, the report card and the coach.** Done.

- Anchored 12-dimension rubric, versioned so scores stay comparable
- Every delivery score must cite a verbatim quote from what you said
- Per question: what was asked, what you said, what a strong answer contains,
  what worked, what was missing, one concrete rewrite instruction, a score and
  a pass/fail verdict
- Deterministic speech metrics measured from the waveform, handed to the model
  as facts rather than asked of it
- Round details recorded on every report: voice, bar, manner, planned vs actual
  length, model and language
- Your final editor contents beside a working solution the evaluator writes in
  the language you were using
- **Three separate conversations**, deliberately distinct: the interviewer
  (during a round, forbidden from helping), the coach (one finished round, with
  its recording — how you *sounded*), and the mentor (every round you have done
  — whether you are *improving*). The mentor's sharpest input is advice that has
  been given more than once, which means a report was read and not acted on.
- **Playback throughout the report** — every evidence quote, every question, and
  the whole round, over a range-supporting authenticated route.
- **JD and experience rounds are extracted, not pasted.** A posting becomes
  weighted competencies with the reasoning behind each; a background becomes
  projects with probe angles plus, most usefully, the claims carrying no
  ownership or no measurement.
- **A coach you can talk to.** After scoring, you can hold a second spoken
  conversation about how you came across. It is handed the recording as an
  inline part on its opening turn, so it has actually heard you — verified
  reporting back on pace, pauses and audible uncertainty. Its subject is
  delivery, not correctness: the report already says whether an answer was
  right; the coach rehearses saying it. Nothing in that conversation is recorded
  or scored.

**Progress tracking.** Done. Score trend, per-dimension movement against the
previous round, four measured metrics each on their own axis, and a table view
so nothing is gated behind a chart.

**Not built yet**

- The Stitch visual redesign (designs exist; implementation is deliberately a
  separate step)
- Report export
- NeetCode's own topic ordering. The list is complete but arrives in LeetCode's
  order, not the Arrays → Two Pointers → … progression the site is known for

---

## Quota: where the ceilings actually are

Measured against the API, not read off a docs page. The two halves of the
product sit on completely different footings:

| Pipeline stage | Model | Free-tier limit | Constrained? |
|---|---|---|---|
| **The interview** | `gemini-3-flash-live` | **unlimited RPM, unlimited RPD** (65K TPM) | **No** |
| Live transcription | `gemini-3.5-transcribe-live` | unlimited RPM/RPD (20K TPM) | No |
| Re-transcription | `gemini-3.5-transcribe-live` | unlimited RPM/RPD (20K TPM) | No |
| **Evaluation** | `gemini-3.6-flash` | 5 RPM · **20 RPD** | **Yes** |
| Evaluation fallback | `gemini-3.5` / `3.1-flash-lite` | 15 RPM · **500 RPD** | No |

**The interviews have no daily cap.** The live model is limited only per
minute, by how much context a session carries, and the app keeps every session
under that by renewing it from the transcript. Only
the post-session report spends a daily quota, and even that has 500/day of
headroom on the Lite models.

Note that a **Google AI Pro subscription does not grant API quota** — it covers
the Gemini app, not API keys. An API key belongs to a Cloud project, and that
project is on the free tier until a billing account is attached to it.

With billing enabled, at the published audio rates:

| | Interview | + report |
|---|---|---|
| 30 min | ~$0.26 | ~$0.58 |
| 60 min | ~$0.52 | ~$1.15 |

### Degradation ladder

`evaluatorChain` steps down by **quota as well as capability**, and
`ModelAvailabilityService` remembers what is exhausted so the chain skips dead
models instead of rediscovering the same 429 before every report. Daily caps
are held until midnight Pacific; per-minute limits for the stated retry delay.

## Notes and gotchas

- **Session length.** The Live API caps audio-only sessions at 15 minutes and
  recycles connections at ~10. Context compression and session resumption are
  on from the start, not bolted on later — this is why a 45-minute round works.
- **Voice activity detection.** `silenceDurationMs` is set to 1400ms, far above
  the default. The default is tuned for chatty assistants and cuts you off
  while you think, which destroys interview realism. This is the single setting
  most worth tuning to your own speaking rhythm.
- **The interviewer will not speak unless spoken to.** The Live API generates
  nothing until the client sends a turn — a system instruction alone leaves the
  model silent after `setupComplete`, however emphatically it is told to begin.
  `LiveInterviewSession.kickoff()` sends a synthetic opening turn. It is
  deliberately not re-sent on reconnect, which would restart the interview
  mid-round.
- **Trailing silence must exceed `silenceDurationMs`.** Anything shorter and
  end-of-speech never commits, so the model waits forever for you to finish.
  This is why the e2e harness pads with 3.2s.
- **`proactivity` and `transparent` are unavailable.** Both are rejected by the
  Developer API on this model (`proactivity` outright, `transparent` is
  Vertex-only). Noted in `live-session.service.ts` where it matters.
- **The interviewer's transcript is not gated on `finished`.** That flag is
  never set on output transcription fragments (measured: 0 of 17 across a full
  turn), so gating on it silently discarded every question the interviewer
  asked. Only `interimInputTranscription` is genuinely interim.
- **Turn timestamps cannot measure speaking time.** Input transcription arrives
  in a burst once you stop talking, so a turn's start and end land milliseconds
  apart however long you spoke. Left unguarded this produced 574,286 words per
  minute and a talk ratio of zero — which the evaluator then faithfully reported
  back as "you spoke for zero seconds". Speaking duration is measured from the
  waveform with energy-based VAD (`audio-analysis.ts`); turn timings are used
  only for response latency, where arrival time is the thing being measured.
- **Bad facts poison the whole report.** That metrics bug did not just produce a
  wrong number, it changed the summary and the overall verdict. Anything handed
  to the evaluator as a fact has to be right or absent.
- **Voice activity detection must bridge short gaps.** People pause between
  words and go quiet on unvoiced consonants. Counting those frames as silence
  shortened the measured speaking time and inflated words-per-minute by ~25%
  (258 wpm on a clip synthesised at 170), which had the report telling you to
  slow down when your pace was already normal.
- **The interviewer stopping mid-sentence is barge-in, not a dropout.**
  Transcription arrives independently of audio, so the text completes even when
  the speech is cut. A breath or a keystroke was enough to trigger it at the
  old 300ms speech-onset padding; it is now 600ms and tunable per person.
- **A React callback in a debounce dependency list is a trap.** `CodeEditor`
  depended on `onPush`, the parent rebuilt it every render, and during a live
  interview transcript deltas re-render several times a second — so the effect
  re-ran, its cleanup cleared the timer, and the 2.5s debounce never elapsed.
  The editor's contents never reached the interviewer for an entire round.
- **Scores are only comparable within a rubric version.** `evaluations.rubric_version`
  exists so that changing the rubric does not silently corrupt your trend line.

---

## License

AGPL-3.0-only, see LICENSE.
