/**
 * iOS never turns a long press into a contextmenu event, so the sidebar's right-click menus were
 * unreachable there. A long press now reaches the row's own onContextMenu, at the finger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";

const { ios } = vi.hoisted(() => ({ ios: { current: true } }));
vi.mock("../utils/constants", () => ({ isIOSWebKit: () => ios.current }));

import { useLongPressContextMenu } from "./useLongPressContextMenu";

const onMenu = vi.fn();

// The shape of a sidebar row: its own right-click handler, and an inline rename field inside it.
function Row() {
  const longPressMenu = useLongPressContextMenu();
  return (
    <div
      data-testid="row"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      {...longPressMenu}
    >
      <input aria-label="rename" />
    </div>
  );
}

const at = { touches: [{ clientX: 40, clientY: 60 }] };

beforeEach(() => {
  vi.useFakeTimers();
  onMenu.mockClear();
  ios.current = true;
});

afterEach(() => {
  // Let any release swallowing a test armed run out, so it cannot reach the next test.
  vi.advanceTimersByTime(10_000);
  vi.useRealTimers();
});

describe("long press on a sidebar row", () => {
  it("opens the row's own menu at the finger on iOS", () => {
    render(<Row />);
    fireEvent.touchStart(screen.getByTestId("row"), at);
    vi.advanceTimersByTime(500);

    expect(onMenu).toHaveBeenCalledWith(40, 60);
  });

  it("does not also tap the row when the finger lifts after the menu opened", () => {
    render(<Row />);
    const row = screen.getByTestId("row");
    fireEvent.touchStart(row, at);
    vi.advanceTimersByTime(500);

    // fireEvent returns false when the default action (the click that follows) was cancelled.
    expect(fireEvent.touchEnd(row)).toBe(false);
  });

  it("leaves a quick tap a tap", () => {
    render(<Row />);
    const row = screen.getByTestId("row");
    fireEvent.touchStart(row, at);
    vi.advanceTimersByTime(200);

    expect(fireEvent.touchEnd(row)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("leaves holding inside the rename field to the field", () => {
    render(<Row />);
    fireEvent.touchStart(screen.getByLabelText("rename"), at);
    vi.advanceTimersByTime(500);

    expect(onMenu).not.toHaveBeenCalled();
  });

  it("gives up when a scroll takes the touch over", () => {
    render(<Row />);
    const row = screen.getByTestId("row");
    fireEvent.touchStart(row, at);
    fireEvent.touchCancel(row);
    vi.advanceTimersByTime(500);

    expect(onMenu).not.toHaveBeenCalled();
  });

  it("stays out of the way where the platform already opens menus itself", () => {
    ios.current = false;
    render(<Row />);
    fireEvent.touchStart(screen.getByTestId("row"), at);
    vi.advanceTimersByTime(500);

    expect(onMenu).not.toHaveBeenCalled();
  });
});

// Menus close on a mousedown outside them (ContextMenu listens on the document), and iOS turns the
// finger lifting into one. On iPad the menu opened and vanished as the finger came up.
describe("the release of the press that opened the menu", () => {
  const closeMenu = vi.fn();

  beforeEach(() => {
    closeMenu.mockClear();
    document.addEventListener("mousedown", closeMenu);
  });

  afterEach(() => {
    document.removeEventListener("mousedown", closeMenu);
  });

  function longPress(): HTMLElement {
    render(<Row />);
    const row = screen.getByTestId("row");
    fireEvent.touchStart(row, at);
    vi.advanceTimersByTime(500);
    return row;
  }

  it("does not close the menu when the finger lifts", () => {
    const row = longPress();
    fireEvent.touchEnd(row);
    fireEvent.mouseDown(document.body);

    expect(closeMenu).not.toHaveBeenCalled();
  });

  it("does not close the menu when the system took the touch over first", () => {
    const row = longPress();
    fireEvent.touchCancel(row);
    fireEvent.mouseDown(document.body);

    expect(closeMenu).not.toHaveBeenCalled();
  });

  it("lets the next touch reach the menu", () => {
    const row = longPress();
    fireEvent.touchEnd(row);
    fireEvent.touchStart(document.body, at);
    fireEvent.mouseDown(document.body);

    expect(closeMenu).toHaveBeenCalledTimes(1);
  });

  it("stops swallowing once the release has had its time", () => {
    longPress();
    vi.advanceTimersByTime(5_000);
    fireEvent.mouseDown(document.body);

    expect(closeMenu).toHaveBeenCalledTimes(1);
  });
});
