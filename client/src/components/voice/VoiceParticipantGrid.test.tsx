/**
 * On iOS voice runs in the native room and the page's LiveKit room never connects, so listing that
 * room showed one nameless icon. There the grid lists the server's voice states instead.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

const { nativeVoice, roomParticipants } = vi.hoisted(() => ({
  nativeVoice: { current: true },
  roomParticipants: { current: [] as { identity: string; name?: string }[] },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@livekit/components-react", () => ({
  useParticipants: () => roomParticipants.current,
  useIsSpeaking: () => false,
}));
vi.mock("../../utils/nativePlugins", () => ({ useNativeVoice: () => nativeVoice.current }));
vi.mock("../../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return {
    useVoiceStore: create(() => ({
      currentVoiceChannelId: null as string | null,
      voiceStates: {},
      activeSpeakers: {},
      watchingScreenShares: {},
    })),
  };
});
vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "me" } })) };
});
vi.mock("../../stores/soundboardStore", async () => {
  const { create } = await import("zustand");
  return { useSoundboardStore: create(() => ({ playingSound: null })) };
});
vi.mock("./VoiceUserContextMenu", () => ({ default: () => null }));

import VoiceParticipantGrid from "./VoiceParticipantGrid";
import { useVoiceStore } from "../../stores/voiceStore";
import type { VoiceState } from "../../types";

function state(userId: string, displayName: string): VoiceState {
  return {
    user_id: userId,
    channel_id: "ch",
    username: userId,
    display_name: displayName,
    avatar_url: "",
    is_muted: false,
    is_deafened: false,
    is_streaming: false,
    is_server_muted: false,
    is_server_deafened: false,
  };
}

function tileOf(name: string): HTMLElement {
  return screen.getByText(name).closest(".voice-participant") as HTMLElement;
}

beforeEach(() => {
  nativeVoice.current = true;
  // What the unconnected JS room reports on iOS: the lone local participant, with no name.
  roomParticipants.current = [{ identity: "" }];
  useVoiceStore.setState({
    currentVoiceChannelId: "ch",
    voiceStates: { ch: [state("alice", "Alice"), state("bob", "Bob")] },
    activeSpeakers: {},
    watchingScreenShares: {},
  });
});

describe("the voice room grid", () => {
  it("shows everyone in the channel by name on iOS", () => {
    const { container } = render(<VoiceParticipantGrid />);

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(container.querySelectorAll(".voice-participant")).toHaveLength(2);
  });

  it("rings whoever the native room reports as speaking on iOS", () => {
    useVoiceStore.setState({ activeSpeakers: { bob: true } });
    render(<VoiceParticipantGrid />);

    const speaking = (name: string) =>
      within(tileOf(name)).getByText(name.charAt(0)).classList.contains("speaking");
    expect(speaking("Bob")).toBe(true);
    expect(speaking("Alice")).toBe(false);
  });

  it("still lists the page's LiveKit room elsewhere", () => {
    nativeVoice.current = false;
    roomParticipants.current = [{ identity: "alice", name: "alice" }];
    const { container } = render(<VoiceParticipantGrid />);

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(container.querySelectorAll(".voice-participant")).toHaveLength(1);
  });
});
