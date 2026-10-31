// Bounded parallelism for fan-outs over IPC. Each item still costs a round
// trip, so the point is to overlap them without opening an unbounded number of
// concurrent requests (docs/AUDIT.md PERF-05 and PERF-06): `Promise.all` over a
// thousand photos would queue a thousand IPC calls at once, which the host
// handles by serialising them anyway — with all of them resident.

/**
 * Map over `items` with at most `limit` promises in flight, preserving order.
 *
 * Rejects with the first error, like `Promise.all`. `limit` is clamped to at
 * least 1, so a bad caller cannot deadlock the queue.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(width, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
