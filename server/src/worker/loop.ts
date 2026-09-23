/** One bounded batch at a time. Yield between busy batches; sleep only when
 * there is no due work. An interval would overlap slow batches and idle
 * unnecessarily after fast ones. */
export function workerLoop(
  poll: () => Promise<number>,
  onError: (error: unknown) => void,
  idleMs = 500,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  async function tick() {
    let count = 0;
    try {
      count = await poll();
    } catch (error) {
      onError(error);
    }
    if (!stopped) timer = setTimeout(tick, count > 0 ? 0 : idleMs);
  }
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
