import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms / 10));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20"]);
  });

  it("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (v) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return v;
    });
    expect(peak).toBe(2);
  });

  it("processes every item when there are more items than workers", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (v) => {
      seen.push(v);
      return v;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles an empty list without hanging", async () => {
    expect(await mapWithConcurrency([], 4, async (v) => v)).toEqual([]);
  });

  it("surfaces a rejection to the caller", async () => {
    const boom = new Error("boom");
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (v) => {
        if (v === 2) throw boom;
        return v;
      })
    ).rejects.toBe(boom);
  });

  // A value-based sentinel (`failure !== null`) could not tell `throw null` from "nothing failed",
  // so the call resolved with a hole in the results instead of rejecting.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
  ])("rejects when a task throws %s", async (_label, thrown) => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (v) => {
        if (v === 2) throw thrown;
        return v;
      })
    ).rejects.toBe(thrown);
  });

  it("stops handing out work once a task has failed", async () => {
    let started = 0;
    const run = mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (v) => {
      started += 1;
      if (v === 1) throw new Error("fail fast");
      await new Promise((r) => setTimeout(r, 5));
      return v;
    });

    await expect(run).rejects.toThrow("fail fast");
    // Worker A failed on the first item; worker B was already on the second. Nothing past those two
    // is picked up, so the remaining four never start.
    expect(started).toBeLessThanOrEqual(2);
  });

  it("waits for in-flight tasks before rejecting, so no task outlives the call", async () => {
    let finished = 0;
    const run = mapWithConcurrency([1, 2], 2, async (v) => {
      if (v === 1) throw new Error("fail fast");
      await new Promise((r) => setTimeout(r, 5));
      finished += 1;
      return v;
    });

    await expect(run).rejects.toThrow("fail fast");
    expect(finished).toBe(1);
  });
});
