/**
 * localStorage that never throws. It throws outright when storage is disabled
 * (Safari private mode, a full quota), and a value written by an older build
 * can be anything, so every caller degrades to its default instead.
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the choice just does not survive a reload */
  }
}

/** Parsed JSON, or null when absent, unreadable or not JSON. Callers validate the shape. */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  writeStored(key, JSON.stringify(value));
}
