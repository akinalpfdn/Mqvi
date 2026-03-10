import { describe, it, expect, beforeEach, vi } from "vitest";
import { useVoiceStore } from "./voiceStore";

// Mock external dependencies that voiceStore imports at module level
vi.mock("../api/voice", () => ({}));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn() }));
vi.mock("../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
}));
vi.mock("./preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}));
vi.mock("./serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "srv1" }) },
}));

function resetStore() {
  useVoiceStore.setState({
    voiceStates: {},
    currentVoiceChannelId: null,
    isMuted: false,
    isDeafened: false,
    isStreaming: false,
    livekitUrl: null,
    livekitToken: null,
    e2eePassphrase: null,
    activeSpeakers: {},
    watchingScreenShares: {},
    screenShareViewers: {},
    preMuteVolumes: {},
    rtt: 0,
    wasReplaced: false,
    _onLeaveCallback: null,
    _wsSend: null,
  });
}

describe("voiceStore", () => {
  beforeEach(() => {
    resetStore();
  });

  // ─── Mute / Deafen Toggle Logic ───

  describe("toggleMute", () => {
    it("should toggle mute on", () => {
      useVoiceStore.getState().toggleMute();
      expect(useVoiceStore.getState().isMuted).toBe(true);
    });

    it("should toggle mute off", () => {
      useVoiceStore.setState({ isMuted: true });
      useVoiceStore.getState().toggleMute();
      expect(useVoiceStore.getState().isMuted).toBe(false);
    });

    it("should disable deafen when toggling mute while deafened", () => {
      useVoiceStore.setState({ isMuted: true, isDeafened: true });
      useVoiceStore.getState().toggleMute();
      const state = useVoiceStore.getState();
      expect(state.isMuted).toBe(false);
      expect(state.isDeafened).toBe(false);
    });
  });

  describe("toggleDeafen", () => {
    it("should enable deafen and mute together", () => {
      useVoiceStore.getState().toggleDeafen();
      const state = useVoiceStore.getState();
      expect(state.isDeafened).toBe(true);
      expect(state.isMuted).toBe(true);
    });

    it("should disable deafen and unmute together", () => {
      useVoiceStore.setState({ isDeafened: true, isMuted: true });
      useVoiceStore.getState().toggleDeafen();
      const state = useVoiceStore.getState();
      expect(state.isDeafened).toBe(false);
      expect(state.isMuted).toBe(false);
    });
  });

  // ─── Voice State WS Handlers ───

  describe("handleVoiceStateUpdate", () => {
    const baseUpdate = {
      user_id: "u1",
      channel_id: "ch1",
      username: "alice",
      display_name: "Alice",
      avatar_url: "",
      is_muted: false,
      is_deafened: false,
      is_streaming: false,
      is_server_muted: false,
      is_server_deafened: false,
    };

    it("should add user on join", () => {
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
      });
      const states = useVoiceStore.getState().voiceStates;
      expect(states["ch1"]).toHaveLength(1);
      expect(states["ch1"][0].user_id).toBe("u1");
    });

    it("should remove user from previous channel on join", () => {
      // User is in ch1
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
        channel_id: "ch1",
      });
      // User moves to ch2
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
        channel_id: "ch2",
      });
      const states = useVoiceStore.getState().voiceStates;
      expect(states["ch1"]).toBeUndefined(); // removed, was empty
      expect(states["ch2"]).toHaveLength(1);
    });

    it("should remove user on leave", () => {
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
      });
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "leave",
      });
      const states = useVoiceStore.getState().voiceStates;
      expect(states["ch1"]).toBeUndefined();
    });

    it("should update mute/deafen/stream state", () => {
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
      });
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "update",
        is_muted: true,
        is_streaming: true,
      });
      const user = useVoiceStore.getState().voiceStates["ch1"][0];
      expect(user.is_muted).toBe(true);
      expect(user.is_streaming).toBe(true);
    });

    it("should clean up empty channel entries on leave", () => {
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "join",
      });
      useVoiceStore.getState().handleVoiceStateUpdate({
        ...baseUpdate,
        action: "leave",
      });
      expect(useVoiceStore.getState().voiceStates).toEqual({});
    });
  });

  describe("handleVoiceStatesSync", () => {
    it("should group states by channel_id", () => {
      useVoiceStore.getState().handleVoiceStatesSync([
        { user_id: "u1", channel_id: "ch1", username: "alice", display_name: "Alice", avatar_url: "", is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false },
        { user_id: "u2", channel_id: "ch1", username: "bob", display_name: "Bob", avatar_url: "", is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false },
        { user_id: "u3", channel_id: "ch2", username: "carol", display_name: "Carol", avatar_url: "", is_muted: true, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false },
      ]);
      const states = useVoiceStore.getState().voiceStates;
      expect(states["ch1"]).toHaveLength(2);
      expect(states["ch2"]).toHaveLength(1);
    });
  });

  // ─── Active Speakers ───

  describe("setActiveSpeakers", () => {
    it("should set active speakers map from array", () => {
      useVoiceStore.getState().setActiveSpeakers(["u1", "u3"]);
      const speakers = useVoiceStore.getState().activeSpeakers;
      expect(speakers["u1"]).toBe(true);
      expect(speakers["u3"]).toBe(true);
      expect(speakers["u2"]).toBeUndefined();
    });

    it("should clear speakers when empty array", () => {
      useVoiceStore.getState().setActiveSpeakers(["u1"]);
      useVoiceStore.getState().setActiveSpeakers([]);
      expect(useVoiceStore.getState().activeSpeakers).toEqual({});
    });
  });

  // ─── Screen Share Viewer Updates ───

  describe("handleScreenShareViewerUpdate", () => {
    it("should set viewer count", () => {
      useVoiceStore.getState().handleScreenShareViewerUpdate({
        streamer_user_id: "u1",
        channel_id: "ch1",
        viewer_count: 3,
        viewer_user_id: "u2",
        action: "watch",
      });
      expect(useVoiceStore.getState().screenShareViewers["u1"]).toBe(3);
    });

    it("should remove entry when viewer count is 0", () => {
      useVoiceStore.setState({ screenShareViewers: { u1: 2 } });
      useVoiceStore.getState().handleScreenShareViewerUpdate({
        streamer_user_id: "u1",
        channel_id: "ch1",
        viewer_count: 0,
        viewer_user_id: "u2",
        action: "unwatch",
      });
      expect(useVoiceStore.getState().screenShareViewers["u1"]).toBeUndefined();
    });
  });

  // ─── Force Disconnect / Replace ───

  describe("handleForceDisconnect", () => {
    it("should clear all voice connection state", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        livekitUrl: "wss://lk.example.com",
        livekitToken: "tok",
        isMuted: true,
        isDeafened: true,
        isStreaming: true,
      });
      useVoiceStore.getState().handleForceDisconnect();
      const state = useVoiceStore.getState();
      expect(state.currentVoiceChannelId).toBeNull();
      expect(state.livekitUrl).toBeNull();
      expect(state.livekitToken).toBeNull();
      expect(state.isMuted).toBe(false);
      expect(state.isDeafened).toBe(false);
      expect(state.isStreaming).toBe(false);
    });
  });

  describe("handleVoiceReplaced", () => {
    it("should set wasReplaced flag and clear connection", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        livekitUrl: "wss://lk.example.com",
      });
      useVoiceStore.getState().handleVoiceReplaced();
      const state = useVoiceStore.getState();
      expect(state.wasReplaced).toBe(true);
      expect(state.currentVoiceChannelId).toBeNull();
    });
  });

  // ─── User Info Update ───

  describe("updateUserInfo", () => {
    it("should update display name and avatar for a user in voice", () => {
      useVoiceStore.setState({
        voiceStates: {
          ch1: [
            { user_id: "u1", channel_id: "ch1", username: "alice", display_name: "Alice", avatar_url: "/old.png", is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false },
          ],
        },
      });
      useVoiceStore.getState().updateUserInfo("u1", "Alice Updated", "/new.png");
      const user = useVoiceStore.getState().voiceStates["ch1"][0];
      expect(user.display_name).toBe("Alice Updated");
      expect(user.avatar_url).toBe("/new.png");
    });

    it("should not modify state if user is not in voice", () => {
      useVoiceStore.setState({ voiceStates: {} });
      useVoiceStore.getState().updateUserInfo("u1", "New", "/new.png");
      expect(useVoiceStore.getState().voiceStates).toEqual({});
    });
  });

  // ─── Settings Actions ───

  describe("setStreaming", () => {
    it("should set streaming state", () => {
      useVoiceStore.getState().setStreaming(true);
      expect(useVoiceStore.getState().isStreaming).toBe(true);
      useVoiceStore.getState().setStreaming(false);
      expect(useVoiceStore.getState().isStreaming).toBe(false);
    });
  });

  describe("setRtt", () => {
    it("should set RTT value", () => {
      useVoiceStore.getState().setRtt(42);
      expect(useVoiceStore.getState().rtt).toBe(42);
    });
  });

  // ─── Local Mute ───

  describe("toggleLocalMute", () => {
    it("should mute user and save pre-mute volume", () => {
      useVoiceStore.setState({ userVolumes: { u1: 80 } });
      useVoiceStore.getState().toggleLocalMute("u1");
      const state = useVoiceStore.getState();
      expect(state.localMutedUsers["u1"]).toBe(true);
      expect(state.userVolumes["u1"]).toBe(0);
      expect(state.preMuteVolumes["u1"]).toBe(80);
    });

    it("should unmute user and restore pre-mute volume", () => {
      useVoiceStore.setState({
        localMutedUsers: { u1: true },
        userVolumes: { u1: 0 },
        preMuteVolumes: { u1: 80 },
      });
      useVoiceStore.getState().toggleLocalMute("u1");
      const state = useVoiceStore.getState();
      expect(state.localMutedUsers["u1"]).toBeUndefined();
      expect(state.userVolumes["u1"]).toBe(80);
      expect(state.preMuteVolumes["u1"]).toBeUndefined();
    });

    it("should default to 100 when no previous volume exists", () => {
      useVoiceStore.setState({ userVolumes: {}, preMuteVolumes: {}, localMutedUsers: {} });
      useVoiceStore.getState().toggleLocalMute("u1");
      expect(useVoiceStore.getState().preMuteVolumes["u1"]).toBe(100);

      useVoiceStore.getState().toggleLocalMute("u1");
      expect(useVoiceStore.getState().userVolumes["u1"]).toBe(100);
    });
  });

  // ─── Leave Voice Channel ───

  describe("leaveVoiceChannel", () => {
    it("should clear all connection state", () => {
      useVoiceStore.setState({
        currentVoiceChannelId: "ch1",
        livekitUrl: "wss://lk.example.com",
        livekitToken: "tok",
        isMuted: true,
        isDeafened: true,
        isStreaming: true,
        activeSpeakers: { u1: true },
        watchingScreenShares: { u2: true },
        screenShareViewers: { u2: 3 },
        rtt: 50,
      });
      useVoiceStore.getState().leaveVoiceChannel();
      const state = useVoiceStore.getState();
      expect(state.currentVoiceChannelId).toBeNull();
      expect(state.livekitUrl).toBeNull();
      expect(state.livekitToken).toBeNull();
      expect(state.isMuted).toBe(false);
      expect(state.isDeafened).toBe(false);
      expect(state.isStreaming).toBe(false);
      expect(state.activeSpeakers).toEqual({});
      expect(state.watchingScreenShares).toEqual({});
      expect(state.screenShareViewers).toEqual({});
      expect(state.rtt).toBe(0);
    });

    it("should send unwatch WS events for active screen shares", () => {
      const wsSend = vi.fn();
      useVoiceStore.setState({
        _wsSend: wsSend,
        watchingScreenShares: { u2: true, u3: true },
      });
      useVoiceStore.getState().leaveVoiceChannel();
      expect(wsSend).toHaveBeenCalledTimes(2);
      expect(wsSend).toHaveBeenCalledWith("screen_share_watch", {
        streamer_user_id: "u2",
        watching: false,
      });
      expect(wsSend).toHaveBeenCalledWith("screen_share_watch", {
        streamer_user_id: "u3",
        watching: false,
      });
    });
  });
});
