/**
 * Wait for `p`, at most `ms` milliseconds; `undefined` when the time ran out first. The timer is
 * cleared as soon as either side settles, so a finished wait never holds the event loop open.
 * A rejection of `p` propagates. An abort of `signal` ends the wait like the timeout (also when
 * already aborted); `ms = Infinity` waits for `p` or the abort only.
 */
export async function raceTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const expired = new Promise<undefined>((resolve) => {
      if (Number.isFinite(ms)) timer = setTimeout(() => resolve(undefined), ms);
      if (signal) {
        onAbort = () => resolve(undefined);
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return await Promise.race([p, expired]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** Abort-aware delay that fast-returns if already aborted and removes its listener when done. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
