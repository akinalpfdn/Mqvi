/**
 * The helper is started from here for both engines. What it is handed decides what viewers get:
 * the HDR engine must carry "Sharp Video"'s own bitrate, and the token must come from the voice
 * channel's server — not whichever server happens to be on screen, which refuses it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../api/voice", () => ({
  getVoiceToken: vi.fn(),
  getScreenShareToken: vi.fn(),
  reportScreenShareFallback: vi.fn(() => Promise.resolve()),
  reportScreenShareStop: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn() }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k, language: "en" } }));
vi.mock("./serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "browsing-server" }) },
}));

import { useVoiceStore } from "./voiceStore";
import { useToastStore } from "./toastStore";
import * as voiceApi from "../api/voice";

const startGameCapture = vi.fn();

beforeEach(() => {
  vi.mocked(voiceApi.getScreenShareToken).mockResolvedValue({
    success: true,
    data: { url: "wss://lk", token: "tok", e2ee_passphrase: "pass", channel_id: "c1" },
  } as Awaited<ReturnType<typeof voiceApi.getScreenShareToken>>);
  vi.mocked(voiceApi.reportScreenShareFallback).mockClear();
  vi.mocked(voiceApi.reportScreenShareStop).mockClear();
  startGameCapture.mockReset().mockResolvedValue({ started: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: "win32",
    startGameCapture,
    stopGameCapture: () => Promise.resolve(),
  };
  useToastStore.setState({ toasts: [] });
  useVoiceStore.setState({
    currentVoiceChannelId: "c1",
    currentVoiceServerId: "voice-server",
    screenShareQuality: "1080p",
    isNativeCapturing: false,
  });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("startNativeCapture", () => {
  it("should hand the HDR engine the browser engine's own bitrate", async () => {
    await useVoiceStore.getState().startNativeCapture("screen:1:0", "sharp_hdr");

    expect(startGameCapture).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "sharp", maxBitrate: 3_000_000, maxHeight: 1080 })
    );
  });

  it("should start smooth with no engine flags, exactly as before", async () => {
    await useVoiceStore.getState().startNativeCapture("screen:1:0", "smooth");

    const opts = startGameCapture.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.engine).toBeUndefined();
    expect(opts.maxBitrate).toBeUndefined();
  });

  it("should ask the voice channel's server for the token, not the one on screen", async () => {
    await useVoiceStore.getState().startNativeCapture("screen:1:0", "smooth");

    expect(voiceApi.getScreenShareToken).toHaveBeenCalledWith("voice-server", "c1");
  });

  it("should mark the share live only once the helper is publishing", async () => {
    const result = await useVoiceStore.getState().startNativeCapture("screen:1:0", "sharp_hdr");

    expect(result).toEqual({ ok: true });
    expect(useVoiceStore.getState().isNativeCapturing).toBe(true);
    expect(useVoiceStore.getState().nativeCapture?.engine).toBe("sharp_hdr");
  });

  it("should carry the engine in a failure, so the report can name it", async () => {
    startGameCapture.mockResolvedValue({ started: false, error: "boom" });

    const result = await useVoiceStore.getState().startNativeCapture("screen:1:0", "sharp_hdr");

    expect(result).toMatchObject({ ok: false, engine: "sharp_hdr", reason: "helper_failed", detail: "boom" });
    expect(useVoiceStore.getState().isNativeCapturing).toBe(false);
  });
});

describe("reportNativeFallback", () => {
  const failure = { ok: false, reason: "helper_failed", serverId: "s1", channelId: "c1" } as const;

  it("should tell the user the HDR correction did not start, not that smooth did not", () => {
    useVoiceStore.getState().reportNativeFallback({ ...failure, engine: "sharp_hdr" as const });

    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["voice:hdrSharpFellBack"]);
    expect(voiceApi.reportScreenShareFallback).toHaveBeenCalledWith("s1", "c1", "sharp_hdr", "helper_failed", undefined);
  });

  it("should keep the smooth wording for smooth", () => {
    useVoiceStore.getState().reportNativeFallback({ ...failure, engine: "smooth" as const });

    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["voice:smoothFellBackToSharp"]);
  });

  it("should stay silent when nothing was attempted", () => {
    useVoiceStore.getState().reportNativeFallback({ ok: false });

    expect(useToastStore.getState().toasts).toEqual([]);
    expect(voiceApi.reportScreenShareFallback).not.toHaveBeenCalled();
  });
});

describe("endNativeCaptureByHelper", () => {
  const toasts = () => useToastStore.getState().toasts;

  beforeEach(() => {
    useVoiceStore.setState({
      isNativeCapturing: true,
      nativeCapture: { engine: "sharp_hdr", startedAt: Date.now() - 60_000 },
    });
  });

  // Closing the shared window is the user ending the share. The browser engine ends quietly then;
  // the helper engines used to call it "stopped unexpectedly", under a mode the user never picked.
  it("should end quietly when the shared source went away", () => {
    useVoiceStore.getState().endNativeCaptureByHelper(3, "");

    expect(toasts()).toEqual([]);
    expect(useVoiceStore.getState().isNativeCapturing).toBe(false);
    expect(useVoiceStore.getState().nativeCapture).toBeNull();
    const [, , engine, reason, aliveMs] = vi.mocked(voiceApi.reportScreenShareStop).mock.calls[0];
    expect([engine, reason]).toEqual(["sharp_hdr", "track_ended"]);
    expect(aliveMs).toBeGreaterThanOrEqual(60_000);
  });

  it("should name the engine that really failed, and report why", () => {
    useVoiceStore.getState().endNativeCaptureByHelper(1, "encoder failed 30 frames in a row");

    expect(toasts().map((t) => t.message)).toEqual(["voice:sharpCaptureStopped"]);
    expect(voiceApi.reportScreenShareStop).toHaveBeenCalledWith(
      "voice-server", "c1", "sharp_hdr", "helper_exited", expect.any(Number), "encoder failed 30 frames in a row"
    );
  });

  it("should keep the smooth wording for a smooth share", () => {
    useVoiceStore.setState({ nativeCapture: { engine: "smooth", startedAt: Date.now() } });
    useVoiceStore.getState().endNativeCaptureByHelper(1, "");

    expect(toasts().map((t) => t.message)).toEqual(["voice:smoothCaptureStopped"]);
  });

  it("should do nothing for a helper we stopped ourselves", () => {
    useVoiceStore.setState({ isNativeCapturing: false, nativeCapture: null });
    useVoiceStore.getState().endNativeCaptureByHelper(0, "");

    expect(toasts()).toEqual([]);
    expect(voiceApi.reportScreenShareStop).not.toHaveBeenCalled();
  });
});
