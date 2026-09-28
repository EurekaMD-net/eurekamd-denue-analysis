import { describe, it, expect } from "vitest";
import { createExtractQueue } from "./extract-queue.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("createExtractQueue", () => {
  it("de-dups concurrent calls for the same key into one run", async () => {
    const q = createExtractQueue();
    let runs = 0;
    const gate = deferred();
    const task = async () => {
      runs++;
      await gate.promise;
      return "done";
    };
    const a = q.enqueue("09015", task);
    const b = q.enqueue("09015", task);
    expect(b).toBe(a);
    expect(q.isPending("09015")).toBe(true);
    expect(q.size()).toBe(1);
    gate.resolve();
    expect(await Promise.all([a, b])).toEqual(["done", "done"]);
    expect(runs).toBe(1);
    expect(q.isPending("09015")).toBe(false);
    expect(q.size()).toBe(0);
  });

  it("runs different keys one at a time (concurrency 1), in order", async () => {
    const q = createExtractQueue();
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const task = (k: string) => async () => {
      active++;
      peak = Math.max(peak, active);
      order.push(`start ${k}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${k}`);
      active--;
    };
    await Promise.all([
      q.enqueue("a", task("a")),
      q.enqueue("b", task("b")),
      q.enqueue("c", task("c")),
    ]);
    expect(peak).toBe(1);
    expect(order).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ]);
  });

  it("a failure rejects its callers, clears the key and does not block the queue", async () => {
    const q = createExtractQueue();
    const failing = q.enqueue("a", async () => {
      throw new Error("osmium died");
    });
    const next = q.enqueue("b", async () => "ok");
    await expect(failing).rejects.toThrow("osmium died");
    expect(await next).toBe("ok");
    expect(q.isPending("a")).toBe(false);
    // A retry after the failure starts a fresh run.
    expect(await q.enqueue("a", async () => "retried")).toBe("retried");
  });
});
