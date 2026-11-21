/**
 * Wait for `p`, at most `ms` milliseconds; `undefined` when the time ran out first. The timer is
 * cleared as soon as either side settles, so a finished wait never holds the event loop open.
 * A rejection of `p` propagates.
 */
export async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    });
    return await Promise.race([p, expired]);
  } finally {
    clearTimeout(timer);
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
