/** A stored session the server could not confirm shows "connecting" — never the login form. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
vi.mock("./components/auth/LoginPage", () => ({ default: () => <div>login-page</div> }));
vi.mock("./components/layout/AppLayout", () => ({ default: () => <div>app-layout</div> }));
vi.mock("./components/landing/LandingPage", () => ({ default: () => <div>landing-page</div> }));
vi.mock("./components/viewers/FileViewerOverlay", () => ({ default: () => null }));

import App from "./App";
import { useAuthStore } from "./stores/authStore";

beforeEach(() => {
  useAuthStore.setState({ initialize: async () => {}, isInitialized: true, user: null });
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe("App while the server is unreachable", () => {
  it("should show the connecting screen instead of the login page", () => {
    useAuthStore.setState({ isServerUnreachable: true });

    renderAt("/login");

    expect(screen.getByText("connectingMessage")).toBeTruthy();
    expect(screen.queryByText("login-page")).toBeNull();
  });

  it("should show the login page once the session is known to be gone", () => {
    useAuthStore.setState({ isServerUnreachable: false });

    renderAt("/login");

    expect(screen.getByText("login-page")).toBeTruthy();
  });
});
