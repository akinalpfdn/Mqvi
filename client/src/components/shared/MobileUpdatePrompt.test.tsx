/** The update prompt: Android back puts the optional one off, and others can see it is up. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

const hook = vi.hoisted(() => ({
  state: { kind: "none" } as { kind: "none" } | { kind: "available"; id: string } | { kind: "required" },
  dismiss: vi.fn(),
  update: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../settings/ConnectionsModal", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <button aria-label="connections-close" onClick={onClose}>
      connections
    </button>
  ),
}));
vi.mock("../../hooks/useMobileUpdate", () => ({
  useMobileUpdate: () => ({ state: hook.state, dismiss: hook.dismiss, update: hook.update }),
}));

import MobileUpdatePrompt from "./MobileUpdatePrompt";
import { useAppUpdateStore } from "../../stores/appUpdateStore";
import { handleBack } from "../../utils/backStack";

beforeEach(() => {
  hook.state = { kind: "none" };
  hook.dismiss.mockClear();
  useAppUpdateStore.setState({ promptVisible: false });
});

describe("MobileUpdatePrompt", () => {
  it("puts the optional prompt off on Android back, and says it is up while shown", () => {
    hook.state = { kind: "available", id: "9" };
    const view = render(<MobileUpdatePrompt />);
    expect(useAppUpdateStore.getState().promptVisible).toBe(true);

    act(() => {
      handleBack();
    });
    expect(hook.dismiss).toHaveBeenCalledTimes(1);

    hook.state = { kind: "none" };
    view.rerender(<MobileUpdatePrompt />);
    expect(useAppUpdateStore.getState().promptVisible).toBe(false);
  });

  it("gives the required prompt no back action", () => {
    hook.state = { kind: "required" };
    render(<MobileUpdatePrompt />);
    expect(handleBack()).toBe(false);
    expect(hook.dismiss).not.toHaveBeenCalled();
    expect(useAppUpdateStore.getState().promptVisible).toBe(true);
  });

  it("offers a way out of a required update: the server switcher, then back to the block", () => {
    hook.state = { kind: "required" };
    render(<MobileUpdatePrompt />);
    expect(screen.queryByText("updateLater")).toBeNull();

    fireEvent.click(screen.getByText("updateChangeServer"));
    expect(screen.getByLabelText("connections-close")).toBeTruthy();
    expect(screen.queryByText("updateRequiredTitle")).toBeNull();

    fireEvent.click(screen.getByLabelText("connections-close"));
    expect(screen.getByText("updateRequiredTitle")).toBeTruthy();
  });
});
