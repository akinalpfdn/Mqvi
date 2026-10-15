/** The web engine's call audio plays here, so deafening a call has to reach this element. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

vi.mock("../../stores/p2pCallStore", async () => {
  const { create } = await import("zustand");
  return {
    useP2PCallStore: create(() => ({
      remoteStream: null as MediaStream | null,
      remoteVolume: 100,
      isDeafened: false,
    })),
  };
});

import P2PAudioSink from "./P2PAudioSink";
import { useP2PCallStore } from "../../stores/p2pCallStore";

// jsdom has no MediaStream; the sink only hands it to the element.
const stream = {} as MediaStream;

beforeEach(() => {
  useP2PCallStore.setState({ remoteStream: stream, remoteVolume: 80, isDeafened: false });
});

describe("the call's audio output", () => {
  it("goes silent while deafened and returns at the volume that was set", () => {
    const { container } = render(<P2PAudioSink />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    expect(audio.volume).toBeCloseTo(0.8);

    act(() => useP2PCallStore.setState({ isDeafened: true }));
    expect(audio.volume).toBe(0);

    act(() => useP2PCallStore.setState({ isDeafened: false }));
    expect(audio.volume).toBeCloseTo(0.8);
  });
});
