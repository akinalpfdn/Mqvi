/**
 * A share's audio run: what is published, unpublished, stopped and said when the capture starts,
 * fails, ends on its own, or the share ends around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { ShareAudioStartResult } from "../hooks/useSystemAudioCapture";
import { SHARE_AUDIO_END_GRACE_MS, startShareAudioRun } from "./shareAudioRun";

const STARTED: ShareAudioStartResult = { status: "started", track: {} as MediaStreamTrack };

function harness() {
  let ended: (() => void) | null = null;
  let resolveStart: (result: ShareAudioStartResult) => void = () => {};
  let resolvePublish: (published: string) => void = () => {};
  let owner = true;
  const deps = {
    start: vi.fn((onEnded: () => void) => {
      ended = onEnded;
      return new Promise<ShareAudioStartResult>((r) => (resolveStart = r));
    }),
    stopCapture: vi.fn(),
    publish: vi.fn(() => new Promise<string>((r) => (resolvePublish = r))),
    unpublish: vi.fn(() => Promise.resolve()),
    isCurrentOwner: () => owner,
    notify: vi.fn(),
    logError: vi.fn(),
  };
  const run = startShareAudioRun(deps);
  return {
    deps,
    run,
    end: () => ended?.(),
    start: (result: ShareAudioStartResult) => resolveStart(result),
    publish: (published: string) => resolvePublish(published),
    loseOwnership: () => (owner = false),
  };
}

/** Lets the run's awaits move on. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function published() {
  const h = harness();
  h.start(STARTED);
  await settle();
  h.publish("pub");
  await settle();
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startShareAudioRun", () => {
  it("should unpublish at once and warn after the grace when the capture ends mid-share", async () => {
    const h = await published();

    h.end();
    await settle();

    expect(h.deps.stopCapture).toHaveBeenCalledTimes(1);
    expect(h.deps.unpublish).toHaveBeenCalledWith("pub");
    expect(h.deps.notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SHARE_AUDIO_END_GRACE_MS);
    expect(h.deps.notify).toHaveBeenCalledWith("shareAudioStopped");
  });

  it("should not warn when the share ends within the grace, as a closed window does", async () => {
    const h = await published();

    h.end();
    vi.advanceTimersByTime(SHARE_AUDIO_END_GRACE_MS / 2);
    h.run.cancel();
    vi.advanceTimersByTime(SHARE_AUDIO_END_GRACE_MS);

    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it("should unpublish a track whose capture ended while it was being published", async () => {
    const h = harness();
    h.start(STARTED);
    await settle();

    h.end();
    h.publish("pub");
    await settle();

    expect(h.deps.unpublish).toHaveBeenCalledWith("pub");
  });

  it("should not publish a track whose capture ended before publishing began", async () => {
    const h = harness();

    h.start(STARTED);
    h.end();
    await settle();

    expect(h.deps.publish).not.toHaveBeenCalled();
    expect(h.deps.stopCapture).toHaveBeenCalled();
  });

  it("should stop the capture and warn when the start fails", async () => {
    const h = harness();

    h.start({ status: "failed" });
    await settle();

    expect(h.deps.stopCapture).toHaveBeenCalledTimes(1);
    expect(h.deps.notify).toHaveBeenCalledWith("shareAudioFailed");
    expect(h.deps.publish).not.toHaveBeenCalled();
  });

  it("should say nothing where share audio is unavailable", async () => {
    const h = harness();

    h.start({ status: "unavailable" });
    await settle();

    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.deps.publish).not.toHaveBeenCalled();
  });

  it("should not warn about a failed start once the share has ended", async () => {
    const h = harness();
    h.run.cancel();

    h.start({ status: "failed" });
    await settle();

    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it("should leave the capture alone once a newer run owns it", async () => {
    const h = await published();
    h.loseOwnership();

    h.end();
    h.run.cancel();
    await settle();
    vi.advanceTimersByTime(SHARE_AUDIO_END_GRACE_MS);

    expect(h.deps.stopCapture).not.toHaveBeenCalled();
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.deps.unpublish).toHaveBeenCalledWith("pub");
  });

  it("should stop the capture and unpublish when the share ends", async () => {
    const h = await published();

    h.run.cancel();
    await settle();

    expect(h.deps.stopCapture).toHaveBeenCalledTimes(1);
    expect(h.deps.unpublish).toHaveBeenCalledWith("pub");
    expect(h.deps.notify).not.toHaveBeenCalled();
  });
});
