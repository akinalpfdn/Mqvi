/**
 * "Sharp Video" in the browser captures an HDR display 8-bit and streams HDR video and games
 * overexposed, while the streamer's own screen looks fine. On an HDR display the picker hands a
 * sharp share to the helper instead, which tone-maps; everywhere else sharp stays in the browser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k, language: "en" } }));

import ScreenPicker from "./ScreenPicker";
import { useVoiceStore, type NativeCaptureResult } from "../../stores/voiceStore";

type HdrAnswer = boolean | null | Promise<boolean | null>;

let showPicker: (sources: { id: string; name: string; thumbnail: string }[]) => void = () => {};
let hdrAnswers: HdrAnswer[] = [];
/** What the picked screen's own monitor answers — the HDR one, unless a test says otherwise. */
let monitorHdr: boolean | null = true;
const sendScreenPickerResult = vi.fn();
const startNativeCapture = vi.fn<(id: string, engine: string) => Promise<NativeCaptureResult>>();
const reportNativeFallback = vi.fn();

function installElectron(smooth: boolean | null) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: "win32",
    onShowScreenPicker: (cb: typeof showPicker) => (showPicker = cb),
    removeScreenPickerListener: () => {},
    sendScreenPickerResult,
    getSmoothCaptureSupport: () => Promise.resolve(smooth),
    getHdrActive: (sourceId?: string) =>
      sourceId ? Promise.resolve(monitorHdr) : Promise.resolve(hdrAnswers.shift() ?? false),
  };
}

async function open() {
  act(() =>
    showPicker([
      { id: "screen:1:0", name: "Screen 1", thumbnail: "" },
      { id: "window:42:0", name: "Game", thumbnail: "" },
    ])
  );
  await act(async () => {
    await Promise.resolve();
  });
}

async function mountAndOpen(smooth: boolean | null, ...answers: HdrAnswer[]) {
  hdrAnswers = answers;
  installElectron(smooth);
  render(<ScreenPicker />);
  await act(async () => {
    await Promise.resolve();
  });
  await open();
}

async function pick(name = "Screen 1") {
  if (name === "Game") await userEvent.click(screen.getByText("screenPickerWindows"));
  await userEvent.click(screen.getByText(name));
}

beforeEach(() => {
  sendScreenPickerResult.mockReset();
  monitorHdr = true;
  startNativeCapture.mockReset().mockResolvedValue({ ok: true });
  reportNativeFallback.mockReset();
  useVoiceStore.setState({
    smoothCaptureSupported: null,
    screenShareMode: "sharp",
    startNativeCapture,
    reportNativeFallback,
  });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("ScreenPicker sharing sharp", () => {
  it("should hand the share to the helper's HDR engine on an HDR display", async () => {
    await mountAndOpen(true, true);
    await pick();

    await waitFor(() => expect(startNativeCapture).toHaveBeenCalledWith("screen:1:0", "sharp_hdr"));
    // The helper carries the video, so getDisplayMedia is cancelled.
    await waitFor(() => expect(sendScreenPickerResult).toHaveBeenCalledWith(null));
  });

  it("should keep the browser on an SDR display", async () => {
    await mountAndOpen(true, false);
    await pick();

    await waitFor(() => expect(sendScreenPickerResult).toHaveBeenCalledWith("screen:1:0"));
    expect(startNativeCapture).not.toHaveBeenCalled();
  });

  it("should fall back to the browser and say so when the HDR engine cannot start", async () => {
    const failure = {
      ok: false,
      engine: "sharp_hdr",
      reason: "helper_failed",
      serverId: "s1",
      channelId: "c1",
    } as const;
    startNativeCapture.mockResolvedValue(failure);
    await mountAndOpen(true, true);
    await pick();

    await waitFor(() => expect(sendScreenPickerResult).toHaveBeenCalledWith("screen:1:0"));
    expect(reportNativeFallback).toHaveBeenCalledWith(failure);
  });

  it("should wait for an HDR answer still on its way rather than guess", async () => {
    let answer: (hdr: boolean) => void = () => {};
    await mountAndOpen(true, new Promise<boolean>((resolve) => (answer = resolve)));
    await pick();
    expect(sendScreenPickerResult).not.toHaveBeenCalled();

    await act(async () => answer(true));
    await waitFor(() => expect(startNativeCapture).toHaveBeenCalledWith("screen:1:0", "sharp_hdr"));
  });

  // Two monitors, one in HDR: the SDR one is captured fine by the browser.
  it("should keep an SDR screen in the browser even with another monitor in HDR", async () => {
    monitorHdr = false;
    await mountAndOpen(true, true);
    await pick();

    await waitFor(() => expect(sendScreenPickerResult).toHaveBeenCalledWith("screen:1:0"));
    expect(startNativeCapture).not.toHaveBeenCalled();
  });

  // A window can be dragged onto the HDR monitor mid-share, which only the helper follows.
  it("should hand a window to the HDR engine when any monitor is in HDR", async () => {
    monitorHdr = false;
    await mountAndOpen(true, true);
    await pick("Game");

    await waitFor(() => expect(startNativeCapture).toHaveBeenCalledWith("window:42:0", "sharp_hdr"));
  });

  it("should ask again on every opening, since HDR is toggled at will", async () => {
    await mountAndOpen(true, true, false);
    await open(); // HDR has been switched off since the first opening
    await pick();

    await waitFor(() => expect(sendScreenPickerResult).toHaveBeenCalledWith("screen:1:0"));
    expect(startNativeCapture).not.toHaveBeenCalled();
  });
});

describe("ScreenPicker sharing smooth", () => {
  it("should use smooth on an HDR display, which tone-maps on its own", async () => {
    useVoiceStore.setState({ screenShareMode: "smooth" });
    await mountAndOpen(true, true);
    await pick();

    await waitFor(() => expect(startNativeCapture).toHaveBeenCalledWith("screen:1:0", "smooth"));
  });

  it("should give a machine without a hardware encoder the HDR engine on an HDR display", async () => {
    useVoiceStore.setState({ screenShareMode: "smooth" });
    await mountAndOpen(false, true);
    await pick();

    await waitFor(() => expect(startNativeCapture).toHaveBeenCalledWith("screen:1:0", "sharp_hdr"));
  });
});
