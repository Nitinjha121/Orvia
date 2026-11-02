import { norm } from './text-norm';

/**
 * Detects and limits repeated questions from the interviewer.
 * Asks are reduced to semantic topic keys so rephrased questions on the same
 * topic are tracked; unrecognized asks fall back to lexical word overlap.
 */

/** What the guard wants the gateway to do about an ask. */
export type RepeatVerdict = {
  /** Stable key for the thing being asked about, for logging. */
  topic: string;
  /** How many times this topic has now been asked, this one included. */
  count: number;
  /**
   * `warn` — the allowance is spent; tell the model to move on before it asks
   * a third time. `insist` — it asked anyway; say so far more bluntly.
   */
  level: 'warn' | 'insist';
  /** The wording of the first time it asked, so the note can quote it back. */
  firstAsked: string;
};

/**
 * The prompt permits one follow-up ("how did you get that?"), so the guard fires
 * AFTER the second ask and the note lands before a third.
 */
const ASKS_ALLOWED = 2;

/**
 * Upper bound on asks before triggering a warning even if the candidate has not answered.
 */
const HARD_CEILING = 4;

/** Below this an unrecognised ask is a nudge ("what are you thinking?"). */
const MIN_CONTENT_WORDS = 3;

/** Word overlap at which two unrecognised asks are the same question. */
const LEXICAL_MATCH = 0.6;

/**
 * Lexical similarity threshold above which a follow-up is treated as an echo
 * of an already answered question, bypassing the normal follow-up allowance.
 */
const ECHO_MATCH = 0.85;

/** Minimum content words required before applying the echo similarity check. */
const MIN_ECHO_WORDS = 3;

/** "Yeah." and "Okay, give me a second" are not answers. */
const MIN_ANSWER_WORDS = 8;

/**
 * Patterns indicating an answer included its own derivation or reasoning,
 * closing single-fact topics to further follow-ups.
 */
const JUSTIFIED = [
  /\bbecause\b/,
  /\bthats why\b/,
  /\bthe reason (being|is|why)\b/,
  /\bsince we\b/,
  /\bwhich is why\b/,
  /\bso that (is|means)\b/,
  /\b(recursion|call) stack\b/,
  /\bat (any|once)\b.{0,40}\bdepth\b/,
  /\bin (the )?worst case\b/,
  /\bhow i (came|come|arrived)\b/,
];

/**
 * Patterns indicating a candidate declined to answer or requested to move on.
 */
const DECLINED = [
  /\b(i|we) (do not|dont) (consider|count|include) (it|that|this|them|(the )?(output|result|results)( space)?)\b/,
  /\b(i|we) (do not|dont) know\b/,
  /\bnot sure\b/,
  /\b(im|i am) stuck\b/,
  /\bno idea\b/,
  /\bi (cant|cannot|can not) (say|tell|answer|derive)\b/,
  /\bi (havent|have not|hadnt|had not) (thought|considered)\b/,
  /\bthats all i (have|know)\b/,
  /\bi (would not|wouldnt|will not|wont) be able\b/,
  /\b(can|could|shall) we (please )?(just )?(move on|skip)\b/,
  // Anchored to the clause end: "then let's move on to the next index" is an
  // explanation, "let's move on" / "...to the next question" a request.
  /\blets (just )?move on( to the next (question|problem|one))?$/,
  /\b(id|i would) like to (just )?move on( to the next (question|problem|one))?$/,
  /\b(are we|is the interview) done\b/,
];

const STOPWORDS = new Set([
  'a', 'about', 'actually', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are',
  'around', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'both', 'but', 'by', 'can',
  'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'each', 'for', 'from', 'get', 'give',
  'go', 'going', 'got', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'know', 'let', 'like', 'looking', 'make', 'may',
  'me', 'might', 'more', 'much', 'my', 'need', 'no', 'not', 'now', 'of', 'ok', 'okay', 'on',
  'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'please', 'put', 're', 'right',
  'run', 's', 'said', 'same', 'say', 'see', 'she', 'should', 'so', 'some', 'still', 'such',
  'take', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'thing', 'things', 'think', 'thinking', 'this', 'those', 'through', 'to', 'too', 'up', 'us',
  'use', 'using', 'very', 'walk', 'want', 'was', 'we', 'well', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',

  // Contractions arrive joined ("whats"), and each is the same function word as
  // its expansion above. Unlisted, two asks would score as similar on nothing
  // but the contractions they share.
  'arent', 'cant', 'couldnt', 'didnt', 'doesnt', 'dont', 'hadnt', 'hasnt', 'havent', 'hes',
  'heres', 'hows', 'id', 'ill', 'im', 'isnt', 'ive', 'lets', 'shes', 'shouldnt', 'thats',
  'theres', 'theyre', 'theyve', 'wasnt', 'weve', 'whats', 'wheres', 'whos', 'wont', 'wouldnt',
  'youd', 'youll', 'youre', 'youve',
]);

/** See `NormOptions.joinContractions` for why apostrophes are deleted here. */
const normAsk = (s: string) => norm(s, { joinContractions: true, keepQuestionMarks: true });

const contentWords = (s: string) =>
  normAsk(s)
    .replace(/\?/g, '')
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

/**
 * The topics a technical round actually asks about.
 *
 * Order matters: the first match wins, so the specific patterns come before the
 * general ones. "output space complexity" must not be filed under `time` or
 * under a bare `space`, because it is the question that was asked six times.
 */
const TOPICS: {
  key: string;
  any: RegExp[];
  allowance?: number;
  /** One fact (a complexity axis) that a derived answer finishes, not an area. */
  singleFact?: boolean;
}[] = [
  {
    // Output space complexity ("size of result", "storing all partitions").
    key: 'complexity:output',
    singleFact: true,
    any: [
      /\boutput\s+(space|size|complexity)\b/,
      /\b(size|magnitude|number|count|complexity)\b[^?]{0,40}\b(of\s+)?(the\s+)?(result|results|output|answer|partitions|subsets|combinations|solutions)\b/,
      /\b(storing|returning|holding)\b[^?]{0,40}\b(result|results|output|answer|partitions|all)\b/,
      /\bhow\s+many\b[^?]{0,40}\b(partitions|subsets|results|combinations|solutions|answers)\b/,
    ],
  },
  {
    key: 'complexity:time',
    singleFact: true,
    any: [/\btime\s+(and\s+space\s+)?complexity\b/, /\btime\s+cost\b/, /\bhow\s+(fast|long)\b[^?]{0,30}\brun\b/],
  },
  {
    key: 'complexity:space',
    singleFact: true,
    any: [/\bspace\s+complexity\b/, /\bmemory\s+(use|usage|footprint|complexity)\b/, /\bextra\s+space\b/],
  },
  {
    // Kept apart from the two above: "what is the complexity" with no axis
    // named is its own ask, and merging it would let the model alternate
    // between the vague and the specific form forever.
    key: 'complexity:general',
    singleFact: true,
    any: [/\bcomplexity\b/, /\bbig\s*o\b/, /\bo\s+of\s+n\b/],
  },
  {
    key: 'edge-cases',
    any: [/\bedge\s+cases?\b/, /\bcorner\s+cases?\b/, /\bwhat\s+if\b[^?]{0,30}\bempty\b/],
    // A broad topic area where probing distinct edge cases is legitimate.
    allowance: 3,
  },
  {
    key: 'approach',
    // Explicit ask patterns rather than generic phrase mentions.
    any: [
      /\bwhat(?:s| is| are| was)?\s+your\s+approach\b/,
      /\byour\s+approach\s+(to|for)\s+(this|the|solving)\b/,
      /\bhow\s+would\s+you\s+(solve|approach|start)\b/,
      /\bwhat(?:s| is| are| was)?\s+your\s+(plan|idea)\b/,
    ],
    singleFact: true,
  },
  { key: 'optimise', any: [/\boptimi[sz]e\b/, /\bmore\s+efficient\b/, /\bdo\s+better\b/, /\bfaster\s+way\b/, /\bimprove\b[^?]{0,30}\b(solution|approach|code)\b/] },
  {
    key: 'tests',
    any: [/\btest\s+cases?\b/, /\bhow\s+would\s+you\s+test\b/],
    allowance: 3,
  },
  {
    key: 'tradeoffs',
    any: [/\btrade[\s-]?offs?\b/, /\bwhat\s+did\s+you\s+give\s+up\b/, /\bwhy\s+not\b[^?]{0,30}\binstead\b/],
    allowance: 3,
  },
  {
    key: 'walkthrough',
    any: [/\bwalk\s+(me\s+)?through\b[^?]{0,40}\b(code|loop|solution|implementation)\b/, /\bwhat\s+(is|does)\s+(this|that)\s+loop\s+doing\b/],
    allowance: 3,
  },
  {
    key: 'dry-run',
    any: [/\bdry\s+run\b/, /\btrace\s+(it\s+)?through\b/, /\bwhat\s+happens\s+(if|when)\s+the\s+input\s+is\b/],
    allowance: 3,
  },
];

/**
 * HR is the one round where re-asking a deflected question is the exercise, and
 * its beats say so: press once, then accept. One extra ask, not an exemption.
 */
export const PRESSURE_EXTRA_ASKS = 1;

export type RepeatGuardOptions = {
  /** `PRESSURE_EXTRA_ASKS` for HR rounds, nothing else. */
  extraAllowance?: number;
};

export class RepeatGuard {
  private readonly extra: number;

  constructor(options: RepeatGuardOptions = {}) {
    this.extra = Math.max(0, options.extraAllowance ?? 0);
  }

  /** The question the round is on; topic counts are scoped per question. */
  private q = 0;

  /**
   * Backward moves are ignored: a re-read of a finished problem must not buy its
   * topics a fresh allowance. That re-read is `QuestionScopeGuard`'s to refuse.
   */
  onQuestion(idx: number) {
    if (idx <= this.q) return;
    this.q = idx;
    // An answer arriving after the switch belongs to the new problem, not to
    // whatever was last asked about the old one.
    this.lastAsked = null;
  }

  /** Scopes a topic to the question it was asked about. */
  private key(topic: string): string {
    return `${this.q}|${topic}`;
  }

  /** scoped topic key -> every wording it has been asked with, in order. */
  private readonly asked = new Map<string, string[]>();
  /** Topics the model has already been told to drop, so it is only told once. */
  private readonly warned = new Set<string>();
  /** The topic of the most recent substantive ask, for attributing an answer. */
  private lastAsked: string | null = null;
  /** Topics refused or "don't know": the end of the topic, not a cue to reword. */
  private readonly declined = new Set<string>();

  /**
   * One completed interviewer turn. Only its question sentences count — the
   * acknowledgement before an ask would otherwise match topics it only mentions.
   */
  observe(turn: string): RepeatVerdict | null {
    let worst: RepeatVerdict | null = null;

    for (const ask of questionsIn(turn)) {
      const verdict = this.record(ask);
      if (!verdict) continue;
      // A turn that stacks two repeats reports the more serious one.
      if (!worst || (worst.level === 'warn' && verdict.level === 'insist')) worst = verdict;
    }
    return worst;
  }

  /**
   * Records that the topic just asked about was answered or refused. Never
   * whether the answer was any good — that is the evaluator's.
   */
  observeCandidate(text: string) {
    const topic = this.lastAsked;
    if (!topic) return;

    if (declined(text)) {
      this.declined.add(topic);
      return;
    }
    if (contentWords(text).length < MIN_ANSWER_WORDS) return;
    /**
     * A candidate turn ending in a question mark is asking a clarifying question,
     * not providing an answer.
     */
    if (/\?\s*$/.test(text.trim())) return;

    this.answered.add(topic);
    const n = normAsk(text);
    if (JUSTIFIED.some((re) => re.test(n))) this.settled.add(topic);
  }

  /** Topics the candidate has given a substantive answer to. */
  private readonly answered = new Set<string>();
  /** Topics answered WITH a derivation, which closes a single-fact topic. */
  private readonly settled = new Set<string>();

  private record(ask: string): RepeatVerdict | null {
    const topic = this.topicOf(ask);

    // The nudge floor applies only to UNRECOGNISED asks: "walk me through the
    // time complexity again?" has two content words, and flooring it let a
    // third ask on a topic go uncorrected.
    if (topic.startsWith('other:') && contentWords(ask).length < MIN_CONTENT_WORDS) return null;
    const key = this.key(topic);
    const history = this.asked.get(key) ?? [];
    history.push(ask);
    this.asked.set(key, history);
    this.lastAsked = key;

    const topicAllowance = TOPICS.find((t) => t.key === topic)?.allowance ?? ASKS_ALLOWED;

    /**
     * A refusal closes any topic; a single fact given with its derivation is
     * finished; an answered area keeps at most the default allowance.
     */
    const single = TOPICS.find((t) => t.key === topic)?.singleFact === true;
    const base =
      this.declined.has(key) ? 1
      : single && this.settled.has(key) ? 1
      : this.answered.has(key) ? Math.min(topicAllowance, ASKS_ALLOWED)
      : topicAllowance;
    // Including after a refusal: pressing once after a deflection is HR's point.
    const allowance = base + this.extra;

    const responded = this.answered.has(key) || this.declined.has(key);

    // An echo ignores the allowance (see ECHO_MATCH), but still honours HR's
    // extra press.
    const mine = new Set(contentWords(ask));
    const echoed =
      responded &&
      history.length > 1 + this.extra &&
      mine.size >= MIN_ECHO_WORDS &&
      history
        .slice(0, -1)
        .some((prev) => {
          const theirs = new Set(contentWords(prev));
          // Both sides, or a terse ask could still be "echoed" by a long one.
          return theirs.size >= MIN_ECHO_WORDS && jaccard(mine, theirs) >= ECHO_MATCH;
        });

    if (!echoed && history.length <= allowance) return null;
    if (!responded && history.length <= HARD_CEILING + this.extra) return null;

    const level: RepeatVerdict['level'] = this.warned.has(key) ? 'insist' : 'warn';
    this.warned.add(key);
    return { topic, count: history.length, level, firstAsked: history[0]! };
  }

  /**
   * A known topic key, or a key derived from an earlier ask this one closely
   * echoes, or a fresh key of its own.
   */
  private topicOf(ask: string): string {
    const n = normAsk(ask);
    for (const t of TOPICS) {
      if (t.any.some((re) => re.test(n))) return t.key;
    }

    // Unrecognised. Fall back to word overlap against previous unrecognised
    // asks, which catches the model repeating itself almost verbatim. Scoped
    // to THIS question, like every other count — see `q`.
    const mine = new Set(contentWords(ask));
    const prefix = this.key('other:');
    for (const [key, history] of this.asked) {
      if (!key.startsWith(prefix)) continue;
      const theirs = new Set(contentWords(history[0]!));
      if (jaccard(mine, theirs) >= LEXICAL_MATCH) return key.slice(this.key('').length);
    }
    return `other:${[...mine].sort().slice(0, 6).join('-') || 'unknown'}`;
  }

  /**
   * How many times a topic has been asked ABOUT THE CURRENT QUESTION. For tests
   * and logging; takes the bare topic key, as the verdict reports it.
   */
  countOf(topic: string): number {
    return this.asked.get(this.key(topic))?.length ?? 0;
  }
}

/**
 * Detects whether a candidate turn is a refusal or declination.
 * Checked at the end of the turn or on turns too short to be substantive answers.
 */
function declined(text: string): boolean {
  const clauses = text
    .split(/[.!?;,]+|\bbut\b/i)
    .map((c) => norm(c, { joinContractions: true }))
    .filter(Boolean);
  const refuses = (c: string) => DECLINED.some((re) => re.test(c));
  if (!clauses.some(refuses)) return false;
  return refuses(clauses.at(-1)!) || contentWords(text).length < MIN_ANSWER_WORDS;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * The asks in an interviewer turn.
 *
 * Sentences ending in a question mark, plus the imperative forms that are
 * questions without the punctuation ("walk me through your solution", "explain
 * your reasoning") — the model uses both and only counting the punctuated ones
 * would let it rephrase its way out of the allowance.
 */
function questionsIn(turn: string): string[] {
  const out: string[] = [];
  for (const raw of turn.split(/(?<=[.?!])\s+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (
      sentence.includes('?') ||
      /^(walk|explain|describe|tell|show|derive|analyse|analyze|justify|talk)\b/i.test(sentence) ||
      /\b(walk me through|explain (why|how|your)|tell me (why|how))\b/i.test(sentence)
    ) {
      out.push(sentence);
    }
  }
  return out;
}
