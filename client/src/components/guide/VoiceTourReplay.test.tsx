/** The voice panel tour can be replayed from Help — only while in a voice channel. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import VoiceTourReplay from "./VoiceTourReplay";
import { useVoiceStore } from "../../stores/voiceStore";
import { useSpotlightStore } from "../../stores/spotlightStore";
import { useSettingsStore } from "../../stores/settingsStore";

beforeEach(() => {
  useSpotlightStore.setState({ tour: null });
  useSettingsStore.setState({ isOpen: true });
});

describe("replaying the voice panel tour", () => {
  it("is off outside voice", () => {
    useVoiceStore.setState({ currentVoiceChannelId: null });
    render(<VoiceTourReplay />);
    expect((screen.getByText("voiceTourButton") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("voiceTourNeedsVoice")).toBeTruthy();
  });

  it("plays in voice, with Settings out of the way", () => {
    useVoiceStore.setState({ currentVoiceChannelId: "v1" });
    render(<VoiceTourReplay />);
    fireEvent.click(screen.getByText("voiceTourButton"));

    expect(useSpotlightStore.getState().tour?.explain?.length).toBeGreaterThan(0);
    expect(useSettingsStore.getState().isOpen).toBe(false);
  });
});
