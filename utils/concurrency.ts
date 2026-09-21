/**
 * Small concurrency helpers. Deliberately dependency-free.
 */

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * Results keep the input order. A rejected worker rejects the whole run.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, n));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= n) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** A promise you can resolve from the outside. Used to implement pause/resume. */
export class Gate {
  private open = true;
  private waiters: Array<() => void> = [];

  close(): void {
    this.open = false;
  }

  release(): void {
    this.open = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }

  isOpen(): boolean {
    return this.open;
  }

  wait(): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/** Sleep helper used for the small backoff between retry attempts. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
