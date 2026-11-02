/**
 * `mm:ss`, zero-padded and fixed-width so a running clock does not jitter the
 * layout as it ticks. Hours are not special-cased: a 90 minute conversation
 * reads "90:12", which is what someone watching an elapsed timer wants.
 */
export const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Returns the user's local calendar day as `YYYY-MM-DD`.
 * Uses local time rather than UTC so late-night activity aligns with the user's date.
 */
export function localDayKey(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
