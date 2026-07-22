/**
 * Maps with a ceiling on how many run at once. Results stay in input order.
 *
 * The ceiling matters wherever each call holds a lot of memory — decoding ten full-size photos at
 * once is hundreds of megabytes and an OOM on a mobile WebView.
 *
 * A rejection from `fn` fails the whole call, but only after every worker has stopped, so no task
 * keeps running against a settled promise and no rejection is left unhandled.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // A separate flag rather than testing the value: `throw null` would leave a value-based sentinel
  // indistinguishable from "no failure", and the call would resolve with a hole in the results.
  let failed = false;
  let failure: unknown;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length || failed) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        // Remember the first failure and let every worker wind down before surfacing it.
        if (!failed) {
          failed = true;
          failure = err;
        }
        return;
      }
    }
  });

  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}
