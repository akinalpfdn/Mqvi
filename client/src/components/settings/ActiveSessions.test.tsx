import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const confirmAnswer = vi.hoisted(() => ({ value: true }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join(",")}` : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("../../api/sessions", () => ({
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));
vi.mock("../../stores/toastStore", () => ({
  useToastStore: <T,>(select: (s: { addToast: () => void }) => T) => select({ addToast: () => {} }),
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.resolve(confirmAnswer.value) }));

import ActiveSessions from "./ActiveSessions";
import * as sessionsApi from "../../api/sessions";
import { useSessionStore } from "../../stores/sessionStore";
import type { DeviceSession } from "../../types";

const laptop: DeviceSession = {
  id: "s-laptop",
  platform: "windows",
  device_label: "desktop",
  ip: "81.214.1.1",
  city: "Istanbul",
  country: "TR",
  created_at: "2026-10-01T10:00:00Z",
  last_active: "2026-10-18T10:00:00Z",
  is_current: true,
};
const phone: DeviceSession = { ...laptop, id: "s-phone", platform: "android", device_label: "mobile", is_current: false };

beforeEach(() => {
  vi.clearAllMocks();
  confirmAnswer.value = true;
  useSessionStore.getState().reset();
  vi.mocked(sessionsApi.listSessions).mockResolvedValue({ success: true, data: [laptop, phone] });
  vi.mocked(sessionsApi.revokeSession).mockResolvedValue({ success: true });
  vi.mocked(sessionsApi.revokeOtherSessions).mockResolvedValue({ success: true, data: { revoked: 1 } });
});

describe("ActiveSessions", () => {
  it("should list each device with where it is and mark this one", async () => {
    render(<ActiveSessions />);

    expect(await screen.findByText(/sessionPlatformAndroid · sessionLabelMobile/)).toBeTruthy();
    expect(screen.getAllByText(/Istanbul, Türkiye · 81\.214\.1\.1|Istanbul, Turkey · 81\.214\.1\.1/)).toHaveLength(2);
    expect(screen.getByText(/sessionThisDevice/)).toBeTruthy();
  });

  it("should offer sign-out for the other device but not for this one", async () => {
    render(<ActiveSessions />);
    await screen.findByText(/sessionPlatformAndroid/);

    expect(screen.getAllByRole("button", { name: "sessionRevoke" })).toHaveLength(1);
  });

  it("should sign the other device out after confirmation and drop it from the list", async () => {
    render(<ActiveSessions />);
    await screen.findByText(/sessionPlatformAndroid/);

    await userEvent.click(screen.getByRole("button", { name: "sessionRevoke" }));

    expect(sessionsApi.revokeSession).toHaveBeenCalledWith("s-phone");
    expect(screen.queryByText(/sessionPlatformAndroid/)).toBeNull();
  });

  it("should leave the device signed in when the confirmation is declined", async () => {
    confirmAnswer.value = false;
    render(<ActiveSessions />);
    await screen.findByText(/sessionPlatformAndroid/);

    await userEvent.click(screen.getByRole("button", { name: "sessionRevoke" }));

    expect(sessionsApi.revokeSession).not.toHaveBeenCalled();
  });

  it("should keep the device listed when the server refuses the sign-out", async () => {
    vi.mocked(sessionsApi.revokeSession).mockResolvedValue({ success: false, error: "x" });
    render(<ActiveSessions />);
    await screen.findByText(/sessionPlatformAndroid/);

    await userEvent.click(screen.getByRole("button", { name: "sessionRevoke" }));

    expect(screen.getByText(/sessionPlatformAndroid/)).toBeTruthy();
  });

  it("should sign out every other device and keep only this one", async () => {
    render(<ActiveSessions />);
    await screen.findByText(/sessionPlatformAndroid/);

    await userEvent.click(screen.getByRole("button", { name: "sessionRevokeOthers" }));

    expect(sessionsApi.revokeOtherSessions).toHaveBeenCalled();
    expect(screen.queryByText(/sessionPlatformAndroid/)).toBeNull();
    expect(screen.queryByRole("button", { name: "sessionRevokeOthers" })).toBeNull();
  });

  it("should credit DB-IP for the locations", async () => {
    render(<ActiveSessions />);

    expect(screen.getByRole("link", { name: "sessionGeoAttribution" }).getAttribute("href")).toBe("https://db-ip.com");
  });
});
