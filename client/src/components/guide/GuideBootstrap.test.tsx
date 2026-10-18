/** The guide greets a new account once — unless an invite already put them in a community. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  openGuide: vi.fn(),
  dismissWelcome: vi.fn(),
  getGuide: vi.fn(),
  markGuideAppUsed: vi.fn(),
  isNativeApp: vi.fn(() => false),
}));

vi.mock("../../utils/openGuide", () => ({ openGuide: mocks.openGuide }));
vi.mock("../../api/auth", () => ({ dismissWelcome: mocks.dismissWelcome }));
vi.mock("../../api/guide", () => ({ getGuide: mocks.getGuide, setGuideHidden: vi.fn(), markGuideAppUsed: mocks.markGuideAppUsed }));
vi.mock("../../utils/constants", () => ({ isNativeApp: mocks.isNativeApp }));
vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  type U = { id: string; has_seen_welcome: boolean; guide_hidden?: boolean };
  const store = create<{ user: U | null; updateUser: (p: Partial<U>) => void }>((set, get) => ({
    user: null,
    updateUser: (p) => set({ user: { ...(get().user as U), ...p } }),
  }));
  return { useAuthStore: store };
});

import GuideBootstrap from "./GuideBootstrap";
import { useAuthStore } from "../../stores/authStore";
import { useGuideStore } from "../../stores/guideStore";

const none = { community: false, message: false, voice: false, friend: false, profile: false, roles: false, app: false };

async function signIn(user: { id: string; has_seen_welcome: boolean; guide_hidden?: boolean }, steps = none) {
  mocks.getGuide.mockResolvedValue({ success: true, data: { steps, hidden: !!user.guide_hidden } });
  useAuthStore.setState({ user } as never);
  await act(async () => {
    render(<GuideBootstrap />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isNativeApp.mockReturnValue(false);
  useGuideStore.getState().reset();
  useAuthStore.setState({ user: null } as never);
});

describe("the guide on sign-in", () => {
  it("opens for a brand-new account and records that it did", async () => {
    await signIn({ id: "u1", has_seen_welcome: false });

    expect(mocks.openGuide).toHaveBeenCalledTimes(1);
    expect(mocks.dismissWelcome).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user?.has_seen_welcome).toBe(true);
  });

  it("stays shut for an account that had it hidden, and does not even ask the server", async () => {
    await signIn({ id: "u1", has_seen_welcome: false, guide_hidden: true });

    expect(mocks.openGuide).not.toHaveBeenCalled();
    expect(mocks.getGuide).not.toHaveBeenCalled(); // reading the guide is a write on the server
  });

  it("does not open again on later sign-ins", async () => {
    await signIn({ id: "u1", has_seen_welcome: true });

    expect(mocks.openGuide).not.toHaveBeenCalled();
    expect(mocks.dismissWelcome).not.toHaveBeenCalled();
  });

  it("leaves someone who came through an invite in their community", async () => {
    await signIn({ id: "u1", has_seen_welcome: false }, { ...none, community: true });

    expect(mocks.openGuide).not.toHaveBeenCalled();
    expect(mocks.dismissWelcome).toHaveBeenCalledTimes(1);
  });

  it("knows a hidden guide is hidden before the server answers", async () => {
    mocks.getGuide.mockReturnValue(new Promise(() => {}));
    useAuthStore.setState({ user: { id: "u1", has_seen_welcome: true, guide_hidden: true } } as never);
    render(<GuideBootstrap />);

    expect(useGuideStore.getState().hidden).toBe(true);
  });

  it("waits for the server before deciding a first visit", async () => {
    mocks.getGuide.mockReturnValue(new Promise(() => {}));
    useAuthStore.setState({ user: { id: "u1", has_seen_welcome: false } } as never);
    render(<GuideBootstrap />);

    expect(mocks.openGuide).not.toHaveBeenCalled();
    expect(mocks.dismissWelcome).not.toHaveBeenCalled();
  });

  it("counts running the app as the app step", async () => {
    mocks.isNativeApp.mockReturnValue(true);
    mocks.markGuideAppUsed.mockResolvedValue({ success: true, data: { steps: { ...none, app: true }, hidden: false } });
    await signIn({ id: "u1", has_seen_welcome: true });

    expect(mocks.markGuideAppUsed).toHaveBeenCalledTimes(1);
    expect(useGuideStore.getState().steps?.app).toBe(true);
  });

  it("never claims the app step from a browser", async () => {
    await signIn({ id: "u1", has_seen_welcome: true });
    expect(mocks.markGuideAppUsed).not.toHaveBeenCalled();
  });
});
