import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ALL_CONCEPTS, STUDY_GUIDES, conceptsOf, guideFor, type Concept, type GuideLabels } from '../lib/study';
import type { FeedPracticeNavState } from '../lib/feedPractice';
import { readStoredJson, writeStoredJson } from '../lib/storage';
import { HAS_PLAYBOOK } from '../lib/playbookPage';
import { Segmented } from './ui/Segmented';
import { RichText } from './ui/RichText';

/** One flat list across every guide: ids are unique across all of them. */
const KEY = 'orvia.study.v1';
const VIEWS = ['all', 'core', 'to learn'] as const;
type View = (typeof VIEWS)[number];

const KNOWN_IDS = new Set(ALL_CONCEPTS.map((c) => c.id));
const TITLE = new Map(ALL_CONCEPTS.map((c) => [c.id, c.title]));

/** Ids that have since left the guides are dropped, so a count cannot exceed its total. */
function readKnown(): string[] {
  const parsed = readStoredJson(KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string' && KNOWN_IDS.has(v));
}

export function StudyPage() {
  const navigate = useNavigate();
  // In the URL so the setup screen and the playbook can link straight to a tab.
  const [params, setParams] = useSearchParams();
  const guide = guideFor(params.get('mode') ?? '') ?? STUDY_GUIDES[0]!;
  const [known, setKnown] = useState<string[]>(() => readKnown());
  const [view, setView] = useState<View>('all');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => writeStoredJson(KEY, known), [known]);

  const concepts = useMemo(() => conceptsOf(guide), [guide]);
  const core = useMemo(() => concepts.filter((c) => c.core), [concepts]);

  const switchGuide = (mode: string) => {
    setParams(mode === STUDY_GUIDES[0]!.mode ? {} : { mode }, { replace: true });
    setOpen(null);
  };

  const toggleKnown = (id: string) =>
    setKnown((k) => (k.includes(id) ? k.filter((x) => x !== id) : [...k, id]));

  const keep = (c: Concept) => view === 'all' || (view === 'core' ? !!c.core : !known.includes(c.id));

  const visible = guide.groups
    .map((g, i) => ({ ...g, n: i + 1, concepts: g.concepts.filter(keep) }))
    .filter((g) => g.concepts.length > 0);

  /** Jumping to a related concept switches back to "all" if the filter hides it. */
  const jumpTo = (id: string) => {
    const target = concepts.find((c) => c.id === id);
    if (target && !keep(target)) setView('all');
    setOpen(id);
    requestAnimationFrame(() =>
      document.getElementById(`concept-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };

  const knownHere = concepts.filter((c) => known.includes(c.id)).length;
  const coreKnown = core.filter((c) => known.includes(c.id)).length;
  const pct = Math.round((knownHere / concepts.length) * 100);

  // Opens the setup screen on this guide's tab with nothing forced; the user
  // still presses start themselves.
  const startRound = () =>
    navigate('/', {
      state: { practice: { mode: guide.mode, questionId: '' } } satisfies FeedPracticeNavState,
    });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div role="group" aria-label="Guide" className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {STUDY_GUIDES.map((g) => (
          <button
            key={g.mode}
            type="button"
            aria-pressed={g.mode === guide.mode}
            onClick={() => switchGuide(g.mode)}
            className={`-mb-px shrink-0 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              g.mode === guide.mode ? 'border-brand text-fg' : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {g.tab}
          </button>
        ))}
      </div>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{guide.title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">{guide.intro}</p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">
            {knownHere} of {concepts.length} known
          </h2>
          <p className="text-xs text-fg-muted">
            Core set: {coreKnown} of {core.length}
          </p>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-alt" role="progressbar"
             aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Concepts known">
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-fg-muted">
          Short on time? The <span className="font-medium text-fg">core</span> set is the{' '}
          {core.length} cards that matter in nearly every round — read those in the ten minutes
          before you start.{HAS_PLAYBOOK && ` How to run the round itself is on the Playbook's ${guide.tab} tab.`}
        </p>
        <div className="mt-3 max-w-sm">
          <Segmented value={view} options={VIEWS} onChange={setView} label="Show" />
        </div>
      </section>

      {visible.length === 0 && (
        <p className="rounded-lg border border-border bg-success-muted p-4 text-sm text-fg">
          Every card here is ticked. Run a round and see which ones hold up under a follow-up.
        </p>
      )}

      {visible.map((g) => (
        <section key={g.id} className="space-y-2">
          <div>
            <h2 className="text-base font-semibold text-fg">
              <span className="mr-1.5 text-sm tabular-nums text-brand">{g.n}</span>
              {g.title}
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-fg-muted">{g.lead}</p>
          </div>
          <ul className="space-y-2">
            {g.concepts.map((c) => (
              <ConceptCard
                key={c.id}
                concept={c}
                labels={guide.labels}
                known={known.includes(c.id)}
                open={open === c.id}
                onOpen={(o) => setOpen((cur) => (o ? c.id : cur === c.id ? null : cur))}
                onKnown={() => toggleKnown(c.id)}
                onJump={jumpTo}
              />
            ))}
          </ul>
        </section>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 sm:p-5">
        <p className="max-w-xl text-sm text-fg-muted">
          Reading is half of it. The other half is saying it out loud under a follow-up.
        </p>
        <button
          type="button"
          onClick={startRound}
          className="shrink-0 rounded-md bg-brand px-3 py-2 text-sm font-semibold text-brand-fg hover:opacity-90"
        >
          {guide.start}
        </button>
      </div>
    </div>
  );
}

function ConceptCard({
  concept: c, labels, known, open, onOpen, onKnown, onJump,
}: {
  concept: Concept;
  labels: GuideLabels;
  known: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onKnown: () => void;
  onJump: (id: string) => void;
}) {
  return (
    <li id={`concept-${c.id}`} className={`scroll-mt-4 rounded-lg border bg-surface ${known ? 'border-success' : 'border-border'}`}>
      <details open={open} onToggle={(e) => onOpen((e.currentTarget as HTMLDetailsElement).open)} className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 marker:content-none sm:px-5">
          <span aria-hidden className="mt-0.5 inline-block w-3 shrink-0 text-fg-subtle transition-transform group-open:rotate-90">›</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={`text-sm font-semibold ${known ? 'text-fg-muted' : 'text-fg'}`}>{c.title}</span>
              {c.core && (
                <span className="rounded bg-brand-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand">core</span>
              )}
              {known && (
                <span className="rounded bg-success-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">known</span>
              )}
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
              <RichText>{c.what}</RichText>
            </span>
          </span>
        </summary>

        <div className="space-y-4 border-t border-border px-4 py-4 sm:px-5">
          <Block label={labels.does}>
            <p className="text-sm leading-relaxed text-fg"><RichText>{c.does}</RichText></p>
          </Block>

          <div className="grid gap-4 sm:grid-cols-2">
            <Block label={labels.reachWhen}>
              <ul className="space-y-1.5">
                {c.reachWhen.map((r) => (
                  <li key={r} className="flex gap-2 text-xs leading-relaxed text-fg">
                    <span aria-hidden className="shrink-0 text-brand">→</span>
                    <span><RichText>{r}</RichText></span>
                  </li>
                ))}
              </ul>
            </Block>
            <Block label={labels.tradeoffs}>
              <ul className="space-y-1.5">
                {c.tradeoffs.map((t) => (
                  <li key={t} className="flex gap-2 text-xs leading-relaxed text-fg">
                    <span aria-hidden className="shrink-0 text-warning">!</span>
                    <span><RichText>{t}</RichText></span>
                  </li>
                ))}
              </ul>
            </Block>
          </div>

          {c.numbers && (
            <Block label={labels.numbers}>
              <p className="rounded-md bg-surface-alt px-3 py-2 text-xs leading-relaxed text-fg">{c.numbers}</p>
            </Block>
          )}

          <Block label={labels.say}>
            <p className="border-l-2 border-brand bg-brand-muted px-3 py-1.5 text-xs leading-relaxed text-fg">{c.say}</p>
          </Block>

          <Block label={labels.check}>
            <p className="text-xs font-medium leading-relaxed text-fg">{c.check.q}</p>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs font-medium text-brand">Show the answer</summary>
              <p className="mt-1.5 rounded-md bg-surface-alt px-3 py-2 text-xs leading-relaxed text-fg">
                <RichText>{c.check.a}</RichText>
              </p>
            </details>
          </Block>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            {c.related && c.related.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                <span>Related:</span>
                {c.related.map((id) => (
                  <button key={id} type="button" onClick={() => onJump(id)}
                    className="rounded border border-border px-1.5 py-0.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg">
                    {TITLE.get(id) ?? id}
                  </button>
                ))}
              </p>
            ) : <span />}
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-fg">
              <input type="checkbox" checked={known} onChange={onKnown}
                     className="size-4 accent-[var(--orvia-color-brand)]" />
              I can explain this
            </label>
          </div>
        </div>
      </details>
    </li>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{label}</p>
      {children}
    </div>
  );
}
