/**
 * Wait for `p`, at most `ms` milliseconds; `undefined` when the time ran out first. The timer is
 * cleared as soon as either side settles, so a finished wait never holds the event loop open.
 * A rejection of `p` propagates. An abort of `signal` ends the wait like the timeout (also when
 * already aborted); `ms = Infinity` waits for `p` or the abort only.
 */
export async function raceTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) {
    // nobody waits for `p` any more: a later rejection must not surface as unhandled
    p.catch(() => undefined);
    return undefined;
  }
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

/**
 * Yield to the macrotask queue so terminal I/O, timers and abort signals can run.
 * Uses `setImmediate` when available (runs after the poll phase with minimal overhead)
 * and falls back to `setTimeout(0)`. Fast-returns when already aborted.
 */
export function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * Cooperative time slicer for CPU-bound async loops: yields to the event loop once
 * `sliceMs` have elapsed since the last yield, and returns `false` when `signal` aborts.
 */
export function createTimeSlicer(sliceMs = 12, signal?: AbortSignal): { check(): Promise<boolean> } {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let last = now();
  return {
    async check(): Promise<boolean> {
      if (signal?.aborted) return false;
      if (now() - last < sliceMs) return true;
      await yieldToEventLoop(signal);
      last = now();
      return !signal?.aborted;
    },
  };
}
