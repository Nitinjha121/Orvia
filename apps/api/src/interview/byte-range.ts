/**
 * One `bytes=` range per RFC 7233 §2.1. A suffix (`bytes=-500`) is the LAST 500
 * bytes; an end past the file is clamped, not refused; anything unparseable,
 * or several ranges, is ignored and the whole file served, which the RFC allows.
 * Only a range starting past the end, or an empty suffix, is 416.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  const end = m[2] ? Number(m[2]) : size - 1;
  return { start, end: Math.min(end, size - 1) };
}
