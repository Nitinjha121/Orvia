import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { isCodeLanguage, type CodeSnippets, type EditorLanguage } from '@orvia/shared';
import CodeMirror from '@uiw/react-codemirror';
import type { Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';

/** `markdown` and `text` are for design notes, which Python highlighting only makes worse. */
const LANGUAGES: { id: EditorLanguage; label: string; group: 'code' | 'notes' }[] = [
  { id: 'python', label: 'Python', group: 'code' },
  { id: 'javascript', label: 'JavaScript', group: 'code' },
  { id: 'typescript', label: 'TypeScript', group: 'code' },
  { id: 'java', label: 'Java', group: 'code' },
  { id: 'cpp', label: 'C++', group: 'code' },
  { id: 'go', label: 'Go', group: 'code' },
  { id: 'rust', label: 'Rust', group: 'code' },
  { id: 'sql', label: 'SQL', group: 'code' },
  { id: 'php', label: 'PHP', group: 'code' },
  { id: 'markdown', label: 'Markdown', group: 'notes' },
  { id: 'text', label: 'Plain text', group: 'notes' },
];

const EXTENSIONS: Record<EditorLanguage, () => Extension[]> = {
  python: () => [python()],
  javascript: () => [javascript()],
  typescript: () => [javascript({ typescript: true })],
  java: () => [java()],
  cpp: () => [cpp()],
  go: () => [go()],
  rust: () => [rust()],
  sql: () => [sql()],
  php: () => [php()],
  markdown: () => [markdown()],
  text: () => [],
};

/** A buffer belongs to one question in one language. */
const bufferKey = (questionId: string | undefined, language: EditorLanguage) =>
  `${questionId ?? ''}::${language}`;

const STARTERS: Record<EditorLanguage, string> = {
  python: 'def solve():\n    pass\n',
  javascript: 'function solve() {\n  \n}\n',
  typescript: 'function solve(): void {\n  \n}\n',
  java: 'class Solution {\n    void solve() {\n        \n    }\n}\n',
  cpp: '#include <vector>\nusing namespace std;\n\nclass Solution {\npublic:\n    void solve() {\n        \n    }\n};\n',
  go: 'package main\n\nfunc solve() {\n\t\n}\n',
  rust: 'fn solve() {\n    \n}\n',
  sql: '-- your query\nSELECT\n',
  php: '<?php\n\nfunction solve() {\n    \n}\n',
  markdown: '## Requirements\n- \n\n## Estimates\n- \n\n## Components\n- \n\n## Trade-offs\n- \n',
  text: 'Requirements:\n- \n\nEstimates:\n- \n\nComponents:\n- \n\nTrade-offs:\n- \n',
};

/** Long enough that the interviewer sees settled thinking, not every keystroke. */
const PUSH_DEBOUNCE_MS = 2500;

export type CodeEditorHandle = {
  /** Sends the open buffer now if it has unsent edits. Call before `session.stop`. */
  flush: () => void;
};

/** Which buffer a push belongs to, captured when the edit was made. */
type OpenBuffer = { key: string; questionId: string | undefined; language: EditorLanguage };

export function CodeEditor({
  language, onLanguageChange, onPush, dark, starterCode, practiceUrl, questionId, ref,
}: {
  language: EditorLanguage;
  onLanguageChange: (l: EditorLanguage) => void;
  /**
   * The contents for the interviewer, tagged with the buffer they belong to —
   * which is not necessarily the one open when this is called, because a swap
   * flushes the buffer it is leaving.
   */
  onPush: (code: string, questionId: string | undefined, language: EditorLanguage) => void;
  dark: boolean;
  /** The question's own skeleton per language; falls back to the generic stubs above. */
  starterCode?: CodeSnippets | null;
  /**
   * Set only for paid-only problems whose skeleton comes from an external host.
   */
  practiceUrl?: string | null;
  /** Which question the editor is open on. Changing it swaps the buffer. */
  questionId?: string;
  ref?: Ref<CodeEditorHandle>;
}) {
  const starterFor = useCallback(
    (l: EditorLanguage) =>
      (isCodeLanguage(l) ? starterCode?.[l] : undefined) ?? STARTERS[l],
    [starterCode],
  );

  const [code, setCode] = useState(() => starterFor(language));
  const [synced, setSynced] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(null);
  /** The last contents sent, so a swap or a flush never sends what the server already has. */
  const lastPushed = useRef(code);

  /**
   * Buffers are keyed by question and language so switching language preserves
   * edits without overwriting skeletons.
   */
  const buffers = useRef(new Map<string, string>());
  const open = useRef<OpenBuffer>({ key: bufferKey(questionId, language), questionId, language });
  const codeRef = useRef(code);
  codeRef.current = code;

  /**
   * Kept in a ref so debounce depends only on `code`, preventing parent re-renders
   * from clearing the timer before it fires.
   */
  const push = useRef(onPush);
  push.current = onPush;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** Sends the open buffer if it differs from what was last sent, tagged with its own key. */
  const flushOpen = useCallback(() => {
    clearTimer();
    const current = codeRef.current;
    if (current === lastPushed.current) return;
    lastPushed.current = current;
    push.current(current, open.current.questionId, open.current.language);
    setSynced(true);
  }, []);

  useImperativeHandle(ref, () => ({ flush: flushOpen }), [flushOpen]);

  const extensions = useMemo(() => EXTENSIONS[language](), [language]);

  /**
   * Swap on a change of question or language, driven by the prop. The previous
   * buffer is flushed first under its own key so recent edits are not lost; the
   * incoming buffer becomes `lastPushed` so the skeleton is not sent as an edit.
   */
  useEffect(() => {
    const key = bufferKey(questionId, language);
    if (key === open.current.key) return;

    flushOpen();
    buffers.current.set(open.current.key, codeRef.current);
    const next = buffers.current.get(key) ?? starterFor(language);

    open.current = { key, questionId, language };
    lastPushed.current = next;
    codeRef.current = next;
    setCode(next);
    setSynced(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, language]);

  // Debounced so the interviewer reacts when you pause, not on every character.
  useEffect(() => {
    if (code === lastPushed.current) return;
    setSynced(false);
    clearTimer();
    timer.current = setTimeout(flushOpen, PUSH_DEBOUNCE_MS);
    return clearTimer;
  }, [code, flushOpen]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value as EditorLanguage)}
          className="rounded-md border border-border bg-surface-alt px-2 py-1 text-xs text-fg focus:border-brand focus:outline-none"
        >
          <optgroup label="Code">
            {LANGUAGES.filter((l) => l.group === 'code').map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </optgroup>
          <optgroup label="Notes">
            {LANGUAGES.filter((l) => l.group === 'notes').map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </optgroup>
        </select>

        <div className="flex items-center gap-3">
          {practiceUrl && (
            <a
              href={practiceUrl}
              target="_blank"
              rel="noreferrer"
              title="This problem is LeetCode Premium. LintCode publishes it free — this skeleton is theirs, so it pastes in and runs."
              className="rounded-md border border-border px-2 py-1 text-xs text-fg-subtle transition-colors hover:border-brand hover:text-brand"
            >
              Run on LintCode ↗
            </a>
          )}

          <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <span
              className="h-1.5 w-1.5 rounded-full transition-colors"
              style={{ background: synced ? 'var(--orvia-color-success)' : 'var(--orvia-color-warning)' }}
            />
            {synced ? 'Interviewer can see this' : 'Typing…'}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          value={code}
          onChange={setCode}
          extensions={extensions}
          theme={dark ? oneDark : undefined}
          height="100%"
          basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: false, highlightActiveLine: true }}
          style={{ fontSize: 13, height: '100%' }}
        />
      </div>
    </div>
  );
}

