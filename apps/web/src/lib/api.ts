import type {
  CodeLanguage, CodeSnippets, DrillRecord, FocusItem, InterviewMode, SessionOptions, Speaker,
  StartSessionInput,
} from '@orvia/shared';
/** Thin fetch wrapper. Cookies carry auth, so every call is credentialed. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Paths whose 401 is an ANSWER, not a lost session: `me` is how a signed-out
 * visitor is detected, and a failed login is a wrong password.
 */
const AUTH_PROBES = new Set(['/api/auth/me', '/api/auth/login']);
const signedOutListeners = new Set<() => void>();

/**
 * Called when any other request comes back 401 — the cookie expired or was
 * cleared mid-session. Without it every page showed "did not load: Not signed
 * in." with a retry that could never work, under a header still signed in.
 */
export function onSignedOut(fn: () => void): () => void {
  signedOutListeners.add(fn);
  return () => {
    signedOutListeners.delete(fn);
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      // Nest wraps zod failures in `message`, which may be an array.
      message = Array.isArray(body?.message) ? body.message.join('; ') : (body?.message ?? message);
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && !AUTH_PROBES.has(path)) signedOutListeners.forEach((fn) => fn());
    throw new ApiError(message, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/* ── shapes returned by the API ────────────────────────────────────────────── */

export type User = { id: string; email: string; name: string };

export type Profile = {
  userId: string;
  experience: string;
  resume: string;
  targetRole: string | null;
  yearsExperience: number | null;
  defaultVoice: string;
  defaultDurationMinutes: number;
  defaultDifficulty: SessionOptions['difficulty'];
  defaultPersona: SessionOptions['persona'];
  silenceDurationMs: number;
  prefixPaddingMs: number;
  /** The server's `profileSchema` accepts exactly `CODE_LANGUAGES`. */
  preferredLanguage: CodeLanguage;
  targetCompany: string | null;
  /** `YYYY-MM-DD`, the reader's own calendar day. */
  targetDate: string | null;
  weeklyRounds: number;
  targetModes: InterviewMode[];
};

export type JobDescription = {
  id: string;
  label: string;
  company: string | null;
  content: string;
  createdAt: string;
};

export type DsaQuestion = {
  id: string;
  title: string;
  difficulty: string;
  topics: string[];
  prompt: string;
  /** LeetCode's skeleton per language; LintCode's for a paid-only problem. */
  codeSnippets: CodeSnippets | null;
  /** Paid-only problems only; see `CodeEditor`'s prop of the same name. */
  practiceUrl: string | null;
  leetcodeId: string | null;
  url: string | null;
};

export type SystemDesignProblem = { id: string; title: string; level: string; prompt: string };

export type CollectionInfo = { id: string; label: string; blurb: string; count: number };

/**
 * One conceptual question, as the BROWSER is allowed to see it.
 *
 * `expectedPoints`, `commonMistakes` and `probes` are absent by design — they
 * are what a strong answer contains and what is coming next, and the API does
 * not send them. Reading the answer key during setup would make the round
 * meaningless.
 */
export type ConceptQuestion = {
  id: string;
  topic: string;
  title: string;
  difficulty: string;
  prompt: string;
};

/** Same redaction: the follow-ups and the model answer stay server-side. */
export type BehaviouralQuestion = {
  id: string;
  competency: string;
  title: string;
  prompt: string;
};

/**
 * An HR scenario as the candidate picks it. The BEATS are withheld — reading
 * the script first turns a negotiation you have to think through into one you
 * have already rehearsed against.
 */
export type HrScenario = {
  id: string;
  title: string;
  blurb: string;
  stage: string;
};
/** A note the mentor wrote about you between conversations. */
export type MentorMemory = {
  id: string;
  kind: string;
  content: string;
  timesObserved: number;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationSummary = {
  id: string;
  scope: 'session' | 'account';
  sessionId: string | null;
  startedAt: string;
  durationMs: number;
  messageCount: number;
};

export type ConversationDetail = ConversationSummary & {
  messages: { idx: number; speaker: 'ai' | 'user'; text: string; atMs: number }[];
};

/**
 * Setup configuration for re-running a past round as a new session.
 * Re-validates configuration server-side and attaches question skeletons.
 * Any questions no longer in the bank are excluded and reported in `missingQuestionIds`.
 */
export type ReplayPlan = {
  sessionId: string;
  input: StartSessionInput;
  questions: DsaQuestion[];
  missingQuestionIds: string[];
};

/** `GET /api/sessions/:id`. */
export type SessionDetail = {
  id: string;
  mode: InterviewMode;
  status: string;
  startedAt: string;
  durationMs: number | null;
  turns: { id: string; speaker: Speaker; text: string; startMs: number }[];
};

export type SessionSummary = {
  id: string;
  mode: InterviewMode;
  status: string;
  startedAt: string;
  durationMs: number | null;
  /** What the round covered — the problems, in the order they were configured. */
  questions: { id: string; title: string; difficulty: string | null }[];
  overallScore: number | null;
  overallVerdict: string | null;
  evaluationStatus: string | null;
  kind: 'round' | 'drill';
  /** Set on a drill: the moment it retried, and the round that moment came from. */
  drill: { label: string; sourceSessionId: string } | null;
  /** Set on an onsite-loop round: which loop, and which stage (from 0). */
  loop: { id: string; stage: number } | null;
};

/**
 * A drill of one moment, ready to start. `input.drill` is only the reference:
 * the server rebuilds the whole drill from it again at start, so the setup
 * here is for the screen — the editor's skeleton and the focus to show.
 */
export type DrillPlan = {
  input: StartSessionInput;
  questions: DsaQuestion[];
  focus: FocusItem[];
  drill: DrillRecord;
};
