/** The phone's sidebar button is the first stop of every guide tour, so it must carry its marker. */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => true }));

import PanelTabBar from "./PanelTabBar";
import { useUIStore } from "../../stores/uiStore";

describe("PanelTabBar on a phone", () => {
  it("marks the sidebar button as the tour's menu stop", () => {
    const { container } = render(<PanelTabBar panelId={useUIStore.getState().activePanelId} />);
    const menu = container.querySelector('[data-tour~="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.getAttribute("title")).toBe("openSidebar");
  });
});
