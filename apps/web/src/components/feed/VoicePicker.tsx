import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { playClips, primeNarration } from '../../lib/narration';
import {
  hasPremiumVoice, listVoices, previewVoice, voicesReady, type SpeechHandle, type VoiceOption,
} from '../../lib/speech';
import type { FeedPage } from '@orvia/shared';
import { localDayKey } from '../../lib/time';

type NarrationVoice = { voice: string; cards: number };

/**
 * Voice and playback speed controls for feed narration.
 * Supports pre-generated audio narration with device speech synthesis fallback.
 */
export function VoicePicker({
  voiceUri,
  rate,
  narrationVoice,
  onNarrationVoice,
  narratedOnly,
  onNarratedOnly,
  onVoice,
  onRate,
  onBeforePreview,
  onClose,
}: {
  voiceUri: string | null;
  rate: number;
  narrationVoice: string | null;
  onNarrationVoice: (voice: string) => void;
  narratedOnly: boolean;
  onNarratedOnly: (value: boolean) => void;
  onVoice: (uri: string) => void;
  onRate: (rate: number) => void;
  /**
   * Called inside the click, before a preview makes a sound. A generated
   * preview plays on the same primed element the reader uses and a device
   * preview cancels the synthesiser, so listening has to stop first.
   */
  onBeforePreview: () => void;
  onClose: () => void;
}) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [premiumAvailable, setPremiumAvailable] = useState(true);
  const [narrationVoices, setNarrationVoices] = useState<NarrationVoice[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const preview = useRef<SpeechHandle | null>(null);

  useEffect(() => () => preview.current?.cancel(), []);

  useEffect(() => {
    let live = true;
    void voicesReady().then(() => {
      if (!live) return;
      setVoices(listVoices());
      setPremiumAvailable(hasPremiumVoice());
    });
    void api
      .get<NarrationVoice[]>('/api/feed/voices')
      .then((v) => live && setNarrationVoices(v))
      .catch((e: unknown) => {
        if (live) setVoicesError(`Could not load the generated voices: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Plays the first clip of a real card in the chosen voice.
   *
   * A sample from the actual feed rather than a canned line, because the point
   * of choosing between voices is hearing one read this material — and it needs
   * no extra endpoint, just the feed filtered to that voice.
   */
  const hearGenerated = async (voice: string) => {
    onBeforePreview();
    preview.current?.cancel();
    // Touched inside the tap: the fetch below leaves the gesture, and iOS only
    // lets an element play later if it was primed during one.
    primeNarration();
    setPreviewing(true);
    setPreviewError(null);
    try {
      const page = await api.get<FeedPage>(
        `/api/feed?limit=1&narrated=true&day=${localDayKey()}&voice=${encodeURIComponent(voice)}`,
      );
      const clips = page.cards.find((c) => c.audio?.length)?.audio;
      if (clips?.length) {
        preview.current = playClips([clips[0]!], {
          onDone: () => {},
          onError: () => setPreviewError('That clip would not play.'),
        });
      } else {
        setPreviewError(`No card has been generated in ${voice} yet.`);
      }
    } catch (e) {
      setPreviewError(`Could not fetch a sample: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPreviewing(false);
    }
  };

  const hearDevice = () => {
    onBeforePreview();
    preview.current?.cancel();
    // The voice the select is SHOWING: with nothing chosen yet that is the
    // top-ranked one, which is also what the reader would use.
    preview.current = previewVoice(voiceUri ?? voices[0]?.uri ?? null, rate);
  };

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg">Reading voice</h2>
        <button onClick={onClose} className="text-xs text-fg-muted hover:text-fg">
          Done
        </button>
      </div>

      {voicesError && <p role="alert" className="mt-2 text-xs text-danger">{voicesError}</p>}

      {narrationVoices.length > 0 && (
        <>
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-fg-muted">
              Generated voice
            </span>
            <select
              value={narrationVoice ?? narrationVoices[0]?.voice}
              onChange={(e) => onNarrationVoice(e.target.value)}
              className="w-full rounded-md border border-border bg-surface-alt px-3 py-2 text-sm text-fg focus:border-brand focus:outline-none"
            >
              {narrationVoices.map((v) => (
                <option key={v.voice} value={v.voice}>
                  {v.voice} · {v.cards} cards ready
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] leading-relaxed text-fg-subtle">
              The natural one. Recorded ahead of time, so it starts instantly and sounds the same on
              every device — but only on cards the narration build has reached.
            </span>
          </label>

          <button
            type="button"
            disabled={previewing}
            onClick={() => void hearGenerated(narrationVoice ?? narrationVoices[0]!.voice)}
            className="mt-2 w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-fg transition-colors active:bg-surface-hover disabled:opacity-60"
          >
            {previewing ? 'Loading…' : 'Hear this voice'}
          </button>
          {previewError && <p role="alert" className="mt-1 text-[11px] text-danger">{previewError}</p>}

          <label className="mt-3 flex items-start gap-2">
            <input
              type="checkbox"
              checked={narratedOnly}
              onChange={(e) => onNarratedOnly(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--orvia-color-brand)]"
            />
            <span className="text-xs leading-relaxed text-fg">
              Read only the generated cards
              <span className="mt-0.5 block text-[11px] text-fg-subtle">
                Skips anything still on the device voice. Fewer cards, all of them natural.
              </span>
            </span>
          </label>
        </>
      )}

      {/* Hidden while "only generated" is on: in that mode the device voice is
          never reached, so showing its controls invites tuning something that
          cannot be heard. */}
      {!(narratedOnly && narrationVoices.length > 0) && (
      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-fg-muted">
          {narrationVoices.length > 0 ? 'Device voice' : 'Voice'}
        </span>
        <select
          value={voiceUri ?? voices[0]?.uri ?? ''}
          onChange={(e) => onVoice(e.target.value)}
          className="w-full rounded-md border border-border bg-surface-alt px-3 py-2 text-sm text-fg focus:border-brand focus:outline-none"
        >
          {voices.map((v) => (
            <option key={v.uri} value={v.uri}>
              {v.name} · {v.lang}
              {v.premium ? ' · high quality' : ''}
            </option>
          ))}
        </select>
      </label>
      )}

      <label className="mt-3 block">
        <span className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-fg-muted">
          Speed
          <span className="tabular-nums text-fg-subtle">{rate.toFixed(2)}×</span>
        </span>
        <input
          type="range"
          min={0.8}
          max={1.4}
          step={0.05}
          value={rate}
          onChange={(e) => onRate(Number(e.target.value))}
          className="w-full accent-[var(--orvia-color-brand)]"
        />
      </label>

      {!(narratedOnly && narrationVoices.length > 0) && (
        <button
          type="button"
          onClick={hearDevice}
          className="mt-2 w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-fg transition-colors active:bg-surface-hover"
        >
          Hear the device voice
        </button>
      )}

      {narrationVoices.length > 0 && !narratedOnly && (
        <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
          Your phone or laptop reading the text itself. Used for cards the build has not reached
          yet, and always for cards quoting your own reports — there is nothing to record in
          advance for those.
        </p>
      )}

      {!premiumAvailable && voices.length > 0 && !(narratedOnly && narrationVoices.length > 0) && (
        <p className="mt-3 text-[11px] leading-relaxed text-fg-subtle">
          None of the high-quality device voices are installed here, which is why it sounds
          synthetic. On a
          Mac: System Settings, Accessibility, Spoken Content, System Voice, Manage Voices — download
          an English voice marked <span className="text-fg-muted">Premium</span> or{' '}
          <span className="text-fg-muted">Enhanced</span>. On iPhone: Settings, Accessibility,
          Spoken Content, Voices. They appear here after a reload and sound close to human.
        </p>
      )}
    </div>
  );
}
