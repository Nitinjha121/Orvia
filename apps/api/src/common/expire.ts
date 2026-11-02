/**
 * A promise resolving to `value` after `ms`, with cancellation.
 * Timers must be cancellable so resolved races do not keep the event loop alive
 * or delay process shutdowns.
 */
export function expire<T>(ms: number, value: T): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}
