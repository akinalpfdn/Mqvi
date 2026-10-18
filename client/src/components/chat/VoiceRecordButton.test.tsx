/** The hold ends where the finger lifts, even when iOS hands the touch to something else. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const recorder = vi.hoisted(() => ({
  state: "idle" as "idle" | "recording",
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../../hooks/useVoiceRecorder", () => ({
  useVoiceRecorder: () => ({ ...recorder, elapsedMs: 0 }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import VoiceRecordButton from "./VoiceRecordButton";

// jsdom has no PointerEvent.
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.pointerId = init.pointerId ?? 1;
  }
}
Object.defineProperty(window, "PointerEvent", { value: FakePointerEvent, configurable: true });

const clip = new File(["x"], "voice.webm");
let now = 0;

beforeEach(() => {
  recorder.state = "idle";
  recorder.start.mockReset().mockImplementation(async () => {
    recorder.state = "recording";
    return true;
  });
  recorder.stop.mockReset().mockResolvedValue(clip);
  recorder.cancel.mockReset();
  now = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

async function hold(onRecorded = vi.fn()) {
  const view = render(<VoiceRecordButton onRecorded={onRecorded} />);
  const mic = screen.getByTitle("voiceMessageHold");
  await act(async () => {
    fireEvent(mic, new FakePointerEvent("pointerdown", { clientY: 500 }));
  });
  view.rerender(<VoiceRecordButton onRecorded={onRecorded} />);
  return { onRecorded, view };
}

describe("holding the mic", () => {
  it("stages the clip when the finger lifts outside the button", async () => {
    const { onRecorded } = await hold();
    now += 2000;

    await act(async () => {
      window.dispatchEvent(new FakePointerEvent("pointerup"));
    });

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(onRecorded).toHaveBeenCalledWith(clip);
  });

  it("drops the recording when the system cancels the touch", async () => {
    await hold();

    await act(async () => {
      window.dispatchEvent(new FakePointerEvent("pointercancel"));
    });

    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(recorder.stop).not.toHaveBeenCalled();
  });

  it("locks when the finger slides up anywhere, and lifting then keeps recording", async () => {
    const { view } = await hold();

    await act(async () => {
      window.dispatchEvent(new FakePointerEvent("pointermove", { clientY: 430 }));
    });
    view.rerender(<VoiceRecordButton onRecorded={vi.fn()} />);
    await act(async () => {
      window.dispatchEvent(new FakePointerEvent("pointerup"));
    });

    expect(recorder.stop).not.toHaveBeenCalled();
    expect(screen.getByText("voiceMessageDone")).toBeTruthy();
  });

  it("shows where to slide while held", async () => {
    const { view } = await hold();
    expect(view.container.querySelector(".voice-rec-lock")).not.toBeNull();
  });

  it("ignores another finger lifting", async () => {
    await hold();

    await act(async () => {
      window.dispatchEvent(new FakePointerEvent("pointerup", { pointerId: 2 }));
    });

    expect(recorder.stop).not.toHaveBeenCalled();
  });

  describe("pressed again while the recorder is still starting", () => {
    function deferredStarts() {
      const pending: ((ok: boolean) => void)[] = [];
      recorder.start.mockImplementation(
        () =>
          new Promise<boolean>((resolve) =>
            pending.push((ok) => {
              if (ok) recorder.state = "recording";
              resolve(ok);
            }),
          ),
      );
      return pending;
    }
    const press = async (mic: HTMLElement) =>
      act(async () => {
        fireEvent(mic, new FakePointerEvent("pointerdown", { clientY: 500 }));
      });
    const lift = async () =>
      act(async () => {
        window.dispatchEvent(new FakePointerEvent("pointerup"));
      });

    it("ignores a quick second tap instead of losing track of the hold", async () => {
      const pending = deferredStarts();
      render(<VoiceRecordButton onRecorded={vi.fn()} />);
      const mic = screen.getByTitle("voiceMessageHold");

      await press(mic);
      await lift();
      await press(mic);
      expect(recorder.start).toHaveBeenCalledTimes(1);

      await act(async () => pending[0](true));
      // The first tap was released before it went live: staged and discarded as too short.
      expect(recorder.stop).toHaveBeenCalledTimes(1);
    });

    it("keeps the new hold's lift when a dropped hold's start resolves late", async () => {
      const pending = deferredStarts();
      const onRecorded = vi.fn();
      const view = render(<VoiceRecordButton onRecorded={onRecorded} />);
      const mic = screen.getByTitle("voiceMessageHold");

      await press(mic);
      await act(async () => {
        window.dispatchEvent(new FakePointerEvent("pointercancel"));
      });
      await press(mic);
      await act(async () => pending[0](false)); // the dropped hold's start, aborted
      await act(async () => pending[1](true));
      view.rerender(<VoiceRecordButton onRecorded={onRecorded} />);

      now += 2000;
      await lift();
      expect(recorder.stop).toHaveBeenCalledTimes(1);
      expect(onRecorded).toHaveBeenCalledWith(clip);
    });
  });
});
