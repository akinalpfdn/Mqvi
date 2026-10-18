/**
 * The login page's connection switcher asks for confirmation and reports errors with toasts. Both
 * were mounted only in AppLayout, so before sign-in the confirm promise never settled and switching
 * servers silently did nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("./i18n", () => ({
  default: { language: "en", t: (k: string) => k },
  changeLanguage: vi.fn(),
  resolveLanguage: () => "en",
  SUPPORTED_LANGUAGES: { en: true, tr: true },
}));
vi.mock("./hooks/useUpdateChecker", () => ({ useUpdateChecker: () => ({ status: "idle" }) }));
vi.mock("./hooks/useDeepLinks", () => ({ useDeepLinks: () => {} }));
vi.mock("./components/layout/AppLayout", () => ({ default: () => <div>app-layout</div> }));
vi.mock("./components/landing/LandingPage", () => ({ default: () => <div>landing-page</div> }));
vi.mock("./components/viewers/FileViewerOverlay", () => ({ default: () => null }));
vi.mock("./components/auth/LoginPage", async () => {
  const { useConfirm } = await import("./hooks/useConfirm");
  const { useToastStore } = await import("./stores/toastStore");
  return {
    default: function FakeLogin() {
      const confirm = useConfirm();
      const addToast = useToastStore((s) => s.addToast);
      return (
        <>
          <button onClick={() => void confirm({ message: "switch-server?" })}>ask</button>
          <button onClick={() => addToast("error", "invalid-url")}>toast</button>
        </>
      );
    },
  };
});

import App from "./App";
import { useAuthStore } from "./stores/authStore";

beforeEach(() => {
  useAuthStore.setState({ initialize: async () => {}, isInitialized: true, isServerUnreachable: false, user: null });
});

function renderLogin() {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <App />
    </MemoryRouter>
  );
}

describe("overlays before sign-in", () => {
  it("should show a confirmation asked for on the login page", async () => {
    renderLogin();

    await userEvent.click(screen.getByRole("button", { name: "ask" }));

    expect(screen.getByText("switch-server?")).toBeTruthy();
  });

  it("should show a toast raised on the login page", async () => {
    renderLogin();

    await userEvent.click(screen.getByRole("button", { name: "toast" }));

    expect(screen.getByText("invalid-url")).toBeTruthy();
  });
});
