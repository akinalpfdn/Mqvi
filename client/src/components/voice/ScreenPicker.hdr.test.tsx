/**
 * "Net Görüntü" captures an HDR display 8-bit and streams HDR video and games overexposed, while
 * the streamer's own screen looks fine — so nobody finds out until a viewer complains. The picker
 * says it before the share, and only when it is true: HDR on, and the share about to go out sharp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k, language: "en" } }));

import ScreenPicker from "./ScreenPicker";
import { useVoiceStore } from "../../stores/voiceStore";

type HdrAnswer = boolean | null | "throws";

let showPicker: (sources: { id: string; name: string; thumbnail: string }[]) => void = () => {};
let hdrAnswers: HdrAnswer[] = [];

function installElectron(smooth: boolean | null) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: "win32",
    onShowScreenPicker: (cb: typeof showPicker) => (showPicker = cb),
    removeScreenPickerListener: () => {},
    sendScreenPickerResult: vi.fn(),
    getSmoothCaptureSupport: () => Promise.resolve(smooth),
    getHdrActive: () => {
      const answer = hdrAnswers.shift() ?? false;
      return answer === "throws" ? Promise.reject(new Error("ipc")) : Promise.resolve(answer);
    },
  };
}

async function open() {
  act(() => showPicker([{ id: "screen:1:0", name: "Screen 1", thumbnail: "" }]));
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

beforeEach(() => {
  useVoiceStore.setState({ smoothCaptureSupported: null, screenShareMode: "sharp" });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("ScreenPicker on an HDR display", () => {
  it("should warn and point at smooth when about to share sharp", async () => {
    await mountAndOpen(true, true);
    expect(screen.getByText("screenHdrSharpWarning")).toBeTruthy();
  });

  it("should not warn when the share goes out smooth, which tone-maps", async () => {
    useVoiceStore.setState({ screenShareMode: "smooth" });
    await mountAndOpen(true, true);
    expect(screen.queryByText("screenHdrSharpWarning")).toBeNull();
  });

  it("should point at Windows' HDR setting when this machine cannot run smooth", async () => {
    useVoiceStore.setState({ screenShareMode: "smooth" });
    await mountAndOpen(false, true);
    expect(screen.getByText("screenHdrNoSmoothWarning")).toBeTruthy();
    expect(screen.queryByText("screenHdrSharpWarning")).toBeNull();
  });

  it("should ask again on every opening, since HDR is toggled at will", async () => {
    await mountAndOpen(true, true, false);
    expect(screen.getByText("screenHdrSharpWarning")).toBeTruthy();

    await open();
    expect(screen.queryByText("screenHdrSharpWarning")).toBeNull();
  });
});

describe("ScreenPicker without a known HDR display", () => {
  it.each([false, null, "throws"] as const)("should not warn (answer: %s)", async (answer) => {
    await mountAndOpen(true, answer);
    expect(screen.queryByText("screenHdrSharpWarning")).toBeNull();
    expect(screen.queryByText("screenHdrNoSmoothWarning")).toBeNull();
  });
});
