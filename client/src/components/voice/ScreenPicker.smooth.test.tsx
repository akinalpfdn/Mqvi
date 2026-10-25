/**
 * A Windows machine with no hardware encoder used to try "Smooth Video" on every share, wait for
 * the helper to fail, and fall back with a warning. The picker now asks the machine once and, when
 * it cannot, offers smooth disabled and shares sharp straight away.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k, language: "en" } }));

import ScreenPicker from "./ScreenPicker";
import { useVoiceStore } from "../../stores/voiceStore";

let showPicker: (sources: { id: string; name: string; thumbnail: string }[]) => void = () => {};
const sendScreenPickerResult = vi.fn();

function installElectron(support: boolean | null | "throws") {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: "win32",
    onShowScreenPicker: (cb: typeof showPicker) => (showPicker = cb),
    removeScreenPickerListener: () => {},
    sendScreenPickerResult,
    getSmoothCaptureSupport: () =>
      support === "throws" ? Promise.reject(new Error("ipc")) : Promise.resolve(support),
    getHdrActive: () => Promise.resolve(false),
    getShareAudioSupport: () => Promise.resolve(true),
    onScreenPermissionDenied: () => {},
    removeScreenPermissionListener: () => {},
  };
}

async function openPicker() {
  render(<ScreenPicker />);
  await act(async () => {
    await Promise.resolve();
  });
  act(() => showPicker([{ id: "screen:1:0", name: "Screen 1", thumbnail: "" }]));
  // Opening also asks about HDR; let that answer land before the test looks.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  sendScreenPickerResult.mockReset();
  useVoiceStore.setState({ smoothCaptureSupported: null, screenShareMode: "smooth" });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("ScreenPicker without a hardware encoder", () => {
  it("should offer smooth disabled, say why, and show sharp as the mode in use", async () => {
    installElectron(false);
    await openPicker();

    const smooth = screen.getByRole("button", { name: /screenModeSmooth/ });
    expect((smooth as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("screenModeSmoothUnavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: /screenModeSharp/ }).className).toContain("sp-mode-opt-active");
  });

  it("should share sharp straight away without starting the helper", async () => {
    installElectron(false);
    const startNativeCapture = vi.fn();
    useVoiceStore.setState({ startNativeCapture });
    await openPicker();

    await userEvent.click(screen.getByText("Screen 1"));

    expect(startNativeCapture).not.toHaveBeenCalled();
    expect(sendScreenPickerResult).toHaveBeenCalledWith("screen:1:0");
  });

  it("should leave the account's smooth preference alone", async () => {
    installElectron(false);
    await openPicker();

    expect(useVoiceStore.getState().screenShareMode).toBe("smooth");
  });
});

describe("ScreenPicker when the machine could not be asked", () => {
  it.each([null, "throws"] as const)("should keep offering smooth (probe answer: %s)", async (answer) => {
    installElectron(answer);
    await openPicker();

    expect((screen.getByRole("button", { name: /screenModeSmooth/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
