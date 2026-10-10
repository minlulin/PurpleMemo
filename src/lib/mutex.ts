// Keyed async mutex (§4): serializes read-modify-write sequences that span
// IPC awaits — e.g. two rapid "record payment" clicks, or a click racing a
// retry. JS is single-threaded, so a promise-chain mutex is sufficient: there
// is no true parallelism in-app, only interleaving at await points. Each repo
// creates its own mutex; keys are per-entity (e.g. `job:12`). Never nest
// withLock calls with the same key — it would deadlock.

export interface KeyedMutex {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<void>>();

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    // The tail never rejects: a failed critical section releases the gate
    // but must not poison the lock for the next waiter.
    const mine: Promise<void> = prev
      .then(() => gate)
      .then(
        () => undefined,
        () => undefined,
      );
    tails.set(key, mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === mine) tails.delete(key);
    }
  }

  return { withLock };
}
