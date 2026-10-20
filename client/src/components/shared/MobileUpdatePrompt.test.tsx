/** The update prompt: Android back puts the optional one off, and others can see it is up. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

const hook = vi.hoisted(() => ({
  state: { kind: "none" } as { kind: "none" } | { kind: "available"; id: string } | { kind: "required" },
  dismiss: vi.fn(),
  update: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
});
