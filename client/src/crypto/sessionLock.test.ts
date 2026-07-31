/**
 * The lock is the whole fix for concurrent ratchet corruption, so its own edges matter: a section
 * that throws must still release, distinct sessions must not queue behind each other, and the map
 * must not keep an entry per session for the lifetime of the tab.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { withSessionLock, pendingSessionLocks } from "./sessionLock";

/** Resolves after every already-queued microtask, so cleanup callbacks have run. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(async () => {
  await settle();
});

describe("withSessionLock", () => {
  it("should run same-key sections one after another, never interleaved", async () => {
    const events: string[] = [];

    const section = (name: string) => async () => {
      events.push(`${name}:enter`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`${name}:exit`);
    };

    await Promise.all([
      withSessionLock("k", section("a")),
      withSessionLock("k", section("b")),
      withSessionLock("k", section("c")),
    ]);

    expect(events).toEqual([
      "a:enter", "a:exit",
      "b:enter", "b:exit",
      "c:enter", "c:exit",
    ]);
  });

  it("should let different keys run concurrently", async () => {
    const events: string[] = [];

    const section = (name: string) => async () => {
      events.push(`${name}:enter`);
      await Promise.resolve();
      events.push(`${name}:exit`);
    };

    await Promise.all([
      withSessionLock("k1", section("a")),
      withSessionLock("k2", section("b")),
    ]);

    // Bulk decrypt touches many sessions; serializing across keys would make the lock a global one.
    expect(events).toEqual(["a:enter", "b:enter", "a:exit", "b:exit"]);
  });

  it("should release when a section throws, and not fail the next one", async () => {
    const failed = withSessionLock("k", async () => {
      throw new Error("boom");
    });

    await expect(failed).rejects.toThrow("boom");

    // The successor must both run and succeed — a deadlock or an inherited rejection here is the
    // failure mode a missing `finally` produces.
    await expect(withSessionLock("k", async () => "ok")).resolves.toBe("ok");
  });

  it("should propagate a failure only to its own caller", async () => {
    const results = await Promise.allSettled([
      withSessionLock("k", async () => {
        throw new Error("boom");
      }),
      withSessionLock("k", async () => "fine"),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1]).toEqual({ status: "fulfilled", value: "fine" });
  });

  it("should forget a key once its queue drains", async () => {
    await withSessionLock("k1", async () => {});
    await withSessionLock("k2", async () => {});
    await settle();

    expect(pendingSessionLocks()).toBe(0);
  });

  it("should keep the key while work is still queued behind it", async () => {
    // The gate is built before the lock call: withSessionLock starts even the first section on a
    // microtask, so capturing `release` from inside the section would leave it unassigned here.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const held = withSessionLock("k", () => gate);
    const queued = withSessionLock("k", async () => {});

    expect(pendingSessionLocks()).toBe(1);

    release();
    await held;
    await queued;
    await settle();

    expect(pendingSessionLocks()).toBe(0);
  });
});
