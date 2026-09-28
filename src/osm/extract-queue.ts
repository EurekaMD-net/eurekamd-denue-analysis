/**
 * Process-wide extraction queue: concurrency 1 (never two osmium passes
 * over the PBF at once) and per-key de-duplication (a second request for a
 * municipio already queued or running shares the same promise).
 */

export interface ExtractQueue {
  /** Run `task` after every earlier task; a key already pending returns its promise. */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
  isPending(key: string): boolean;
  /** Distinct keys queued or running. */
  size(): number;
}

export function createExtractQueue(): ExtractQueue {
  const pending = new Map<string, Promise<unknown>>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
      const existing = pending.get(key);
      if (existing) return existing as Promise<T>;
      const p = tail.then(task);
      tail = p.catch(() => undefined);
      pending.set(key, p);
      const clear = () => {
        if (pending.get(key) === p) pending.delete(key);
      };
      p.then(clear, clear);
      return p;
    },
    isPending: (key) => pending.has(key),
    size: () => pending.size,
  };
}

/** The queue shared by the API handler (one per process). */
export const extractQueue = createExtractQueue();
