/** On a phone the settings menu is a drawer over the page; while it is open the page is not usable. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => true }));
vi.mock("./SettingsNav", () => ({
  default: ({ onNavigate }: { onNavigate?: () => void }) => (
    <button data-tour="settings-profile" onClick={onNavigate} aria-label="nav-profile">
      profile
    </button>
  ),
}));
vi.mock("./VoiceSettings", () => ({ default: () => null }));
vi.mock("./ProfileSettings", () => ({ default: () => <button data-tour="avatar">avatar</button> }));

import SettingsModal from "./SettingsModal";
import { useSettingsStore } from "../../stores/settingsStore";

describe("SettingsModal on a phone", () => {
  beforeEach(() => {
    useSettingsStore.getState().closeSettings();
  });

  it("keeps the page inert under the open menu, and usable once an item is chosen", () => {
    const { container, getByLabelText } = render(<SettingsModal />);
    act(() => useSettingsStore.getState().openSettings());
    const avatar = () => container.querySelector('[data-tour="avatar"]');
    expect(avatar()?.closest("[inert]")).not.toBeNull();

    fireEvent.click(getByLabelText("nav-profile"));
    expect(avatar()?.closest("[inert]")).toBeNull();
  });
});
