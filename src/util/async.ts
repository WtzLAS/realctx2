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
