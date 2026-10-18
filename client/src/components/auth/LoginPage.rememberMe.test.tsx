/** "Remember me" failures reach the server by themselves once the user is signed in. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../i18n", () => ({
  default: { language: "en", t: (k: string) => k },
  changeLanguage: vi.fn(),
  resolveLanguage: () => "en",
  SUPPORTED_LANGUAGES: { en: true, tr: true },
}));
vi.mock("../../api/auth", () => ({ reportCredentialStoreFailure: vi.fn() }));
vi.mock("./AccountRecoveryModal", () => ({ default: () => null }));
vi.mock("../settings/ConnectionsModal", () => ({ default: () => null }));

import LoginPage from "./LoginPage";
import { useAuthStore } from "../../stores/authStore";
import { reportCredentialStoreFailure } from "../../api/auth";
import type { CredentialStoreFailure } from "../../types/electron";

const report = vi.mocked(reportCredentialStoreFailure);
const decryptFailure: CredentialStoreFailure = {
  reason: "decrypt_failed",
  detail: "Error while decrypting the ciphertext",
  platform: "windows",
  backend: "",
};

function installElectron(api: Record<string, unknown>) {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
}

beforeEach(() => {
  localStorage.clear();
  report.mockReset();
  report.mockResolvedValue({ success: true, httpStatus: 204 });
  useAuthStore.setState({ login: async () => true, user: null, error: null, isLoading: false });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function signIn() {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
  await userEvent.type(document.getElementById("username") as HTMLElement, "alice");
  await userEvent.type(document.getElementById("password") as HTMLElement, "correct horse");
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "login" }));
}

describe("LoginPage remember me", () => {
  it("should report a stored copy that could not be read, after the user signs in", async () => {
    installElectron({
      loadCredentials: async () => ({ credentials: null, failure: decryptFailure }),
      saveCredentials: async () => ({ ok: true }),
      clearCredentials: async () => {},
    });

    await signIn();

    await waitFor(() => expect(report).toHaveBeenCalledWith("load", decryptFailure));
  });

  it("should report a save that failed instead of pretending it worked", async () => {
    const saveFailure: CredentialStoreFailure = { ...decryptFailure, reason: "unavailable", detail: "" };
    installElectron({
      loadCredentials: async () => ({ credentials: null }),
      saveCredentials: async () => ({ ok: false, failure: saveFailure }),
      clearCredentials: async () => {},
    });

    await signIn();

    await waitFor(() => expect(report).toHaveBeenCalledWith("save", saveFailure));
  });

  it("should send nothing when remembering worked", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    installElectron({
      loadCredentials: async () => ({ credentials: null }),
      saveCredentials: save,
      clearCredentials: async () => {},
    });

    await signIn();

    await waitFor(() => expect(save).toHaveBeenCalledWith("alice", "correct horse"));
    expect(report).not.toHaveBeenCalled();
  });
});
