/**
 * Bounded-concurrency map — runs `fn` over `items` with at most `limit` calls
 * in flight at once, instead of either fully sequential (slow) or fully
 * unbounded Promise.all (can trip provider rate limits, e.g. Twelve Data /
 * Gemini, turning "fast" into "throttled and just as slow").
 *
 * No external dependency (e.g. p-limit) — this project deliberately has zero
 * ML/infra dependencies for serverless-friendliness; this is ~15 lines.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
