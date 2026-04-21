/**
 * voiceWsSlice — WebSocket event handlers for voice state.
 *
 * Pure state transformers — no side effects beyond updating Zustand state.
 * Handlers cross-slice: disconnect handlers also reset screenshare fields
 * owned by voiceScreenShareSlice. Legal because slices share a single store.
 */

import type { StateCreator } from "zustand";
import type { VoiceState, VoiceStateUpdateData } from "../../types";
import type { VoiceStore } from "../voiceStore";
import { clearVoiceRecoveryMark } from "../shared/voiceRecovery";

export type VoiceWsSlice = {
  afkKickInfo: { channelName: string; serverName: string } | null;

  handleVoiceStateUpdate: (data: VoiceStateUpdateData) => void;
  handleVoiceStatesSync: (states: VoiceState[]) => void;
  updateUserInfo: (userId: string, displayName: string, avatarUrl: string) => void;
  handleForceDisconnect: () => void;
  handleAFKKick: (channelName: string, serverName: string) => void;
  handleVoiceReplaced: () => void;
  handleScreenShareViewerUpdate: (data: {
    streamer_user_id: string;
    channel_id: string;
    viewer_count: number;
    viewer_user_id: string;
    action: string;
  }) => void;
  dismissAFKKick: () => void;
};

export const createVoiceWsSlice: StateCreator<
  VoiceStore,
  [],
  [],
  VoiceWsSlice
> = (set) => ({
  afkKickInfo: null,

  handleVoiceStateUpdate: (data: VoiceStateUpdateData) => {
    set((state) => {
      const newStates = { ...state.voiceStates };

      switch (data.action) {
        case "join": {
          // Remove user from all channels (can only be in one)
          for (const channelId of Object.keys(newStates)) {
            newStates[channelId] = newStates[channelId].filter(
              (s) => s.user_id !== data.user_id
            );
            if (newStates[channelId].length === 0) {
              delete newStates[channelId];
            }
          }

          const channelStates = newStates[data.channel_id] ?? [];
          newStates[data.channel_id] = [
            ...channelStates,
            {
              user_id: data.user_id,
              channel_id: data.channel_id,
              username: data.username,
              display_name: data.display_name,
              avatar_url: data.avatar_url,
              is_muted: data.is_muted,
              is_deafened: data.is_deafened,
              is_streaming: data.is_streaming,
              is_server_muted: data.is_server_muted,
              is_server_deafened: data.is_server_deafened,
            },
          ];
          break;
        }

        case "leave": {
          if (newStates[data.channel_id]) {
            newStates[data.channel_id] = newStates[data.channel_id].filter(
              (s) => s.user_id !== data.user_id
            );
            if (newStates[data.channel_id].length === 0) {
              delete newStates[data.channel_id];
            }
          }
          break;
        }

        case "update": {
          if (newStates[data.channel_id]) {
            newStates[data.channel_id] = newStates[data.channel_id].map((s) =>
              s.user_id === data.user_id
                ? {
                    ...s,
                    is_muted: data.is_muted,
                    is_deafened: data.is_deafened,
                    is_streaming: data.is_streaming,
                    is_server_muted: data.is_server_muted,
                    is_server_deafened: data.is_server_deafened,
                  }
                : s
            );
          }
          break;
        }
      }

      return { voiceStates: newStates };
    });
  },

  handleVoiceStatesSync: (states: VoiceState[]) => {
    const grouped: Record<string, VoiceState[]> = {};

    for (const state of states) {
      if (!grouped[state.channel_id]) {
        grouped[state.channel_id] = [];
      }
      grouped[state.channel_id].push(state);
    }

    set({ voiceStates: grouped });
  },

  updateUserInfo: (userId, displayName, avatarUrl) => {
    set((state) => {
      let changed = false;
      const newStates = { ...state.voiceStates };

      for (const channelId of Object.keys(newStates)) {
        const idx = newStates[channelId].findIndex((s) => s.user_id === userId);
        if (idx !== -1) {
          const entry = newStates[channelId][idx];
          if (entry.display_name !== displayName || entry.avatar_url !== avatarUrl) {
            const newArr = [...newStates[channelId]];
            newArr[idx] = { ...entry, display_name: displayName, avatar_url: avatarUrl };
            newStates[channelId] = newArr;
            changed = true;
          }
        }
      }

      return changed ? { voiceStates: newStates } : {};
    });
  },

  handleForceDisconnect: () => {
    console.warn("[voiceStore] handleForceDisconnect CALLED", { timestamp: new Date().toISOString() });
    clearVoiceRecoveryMark();
    // Admin force-disconnected us — same cleanup as leave but no WS event sent
    // (server already cleared state). isMuted/isDeafened preserved.
    set({
      currentVoiceChannelId: null,
      currentVoiceServerId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      isStreaming: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
    });
  },

  handleAFKKick: (channelName: string, serverName: string) => {
    console.warn("[voiceStore] handleAFKKick CALLED", { timestamp: new Date().toISOString(), channelName, serverName });
    clearVoiceRecoveryMark();
    set({
      currentVoiceChannelId: null,
      currentVoiceServerId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      isStreaming: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
      afkKickInfo: { channelName, serverName },
    });
  },

  dismissAFKKick: () => set({ afkKickInfo: null }),

  handleVoiceReplaced: () => {
    console.warn("[voiceStore] handleVoiceReplaced CALLED", { timestamp: new Date().toISOString() });
    clearVoiceRecoveryMark();
    // Another session took over voice — leave silently, skip auto-rejoin.
    set({
      wasReplaced: true,
      currentVoiceChannelId: null,
      currentVoiceServerId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      isStreaming: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
    });
  },

  handleScreenShareViewerUpdate: (data) => {
    set((state) => {
      const next = { ...state.screenShareViewers };
      if (data.viewer_count > 0) {
        next[data.streamer_user_id] = data.viewer_count;
      } else {
        delete next[data.streamer_user_id];
      }
      return { screenShareViewers: next };
    });
  },
});
