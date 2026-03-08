/**
 * Channel Permission Store — Per-channel permission override management.
 *
 * Data structure: Record<channelId, ChannelPermissionOverride[]>
 * Overrides are fetched on first access and cached.
 */

import { create } from "zustand";
import * as channelPermApi from "../api/channelPermissions";
import { useServerStore } from "./serverStore";
import type { ChannelPermissionOverride } from "../types";

/** Stable empty ref for selectors */
const EMPTY_OVERRIDES: ChannelPermissionOverride[] = [];

type ChannelPermissionState = {
  overridesByChannel: Record<string, ChannelPermissionOverride[]>;
  /** Tracks which channels have been fetched (prevents duplicate requests) */
  fetchedChannels: Set<string>;

  // ─── Actions ───
  fetchOverrides: (channelID: string) => Promise<void>;
  setOverride: (channelID: string, roleID: string, allow: number, deny: number) => Promise<boolean>;
  deleteOverride: (channelID: string, roleID: string) => Promise<boolean>;
  getOverrides: (channelID: string) => ChannelPermissionOverride[];

  /** Batch-fetch overrides for multiple channels (skips already-fetched) */
  fetchOverridesForChannels: (channelIDs: string[]) => void;

  // ─── WS Event Handlers ───
  handleOverrideUpdate: (override: ChannelPermissionOverride) => void;
  handleOverrideDelete: (channelID: string, roleID: string) => void;
};

export const useChannelPermissionStore = create<ChannelPermissionState>(
  (set, get) => ({
    overridesByChannel: {},
    fetchedChannels: new Set(),

    fetchOverrides: async (channelID) => {
      if (get().fetchedChannels.has(channelID)) return;

      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return;

      const res = await channelPermApi.getOverrides(serverId, channelID);
      if (res.data) {
        set((state) => ({
          overridesByChannel: {
            ...state.overridesByChannel,
            [channelID]: res.data!,
          },
          fetchedChannels: new Set([...state.fetchedChannels, channelID]),
        }));
      }
    },

    setOverride: async (channelID, roleID, allow, deny) => {
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return false;
      const res = await channelPermApi.setOverride(
        serverId,
        channelID,
        roleID,
        allow,
        deny
      );
      // State updated via WS broadcast (handleOverrideUpdate)
      return !!res.data;
    },

    deleteOverride: async (channelID, roleID) => {
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return false;
      const res = await channelPermApi.deleteOverride(serverId, channelID, roleID);
      return !!res.data;
    },

    getOverrides: (channelID) => {
      return get().overridesByChannel[channelID] ?? EMPTY_OVERRIDES;
    },

    fetchOverridesForChannels: (channelIDs) => {
      const { fetchedChannels, fetchOverrides } = get();
      for (const id of channelIDs) {
        if (!fetchedChannels.has(id)) {
          fetchOverrides(id);
        }
      }
    },

    // ─── WS Event Handlers ───

    handleOverrideUpdate: (override) => {
      set((state) => {
        const existing = state.overridesByChannel[override.channel_id] ?? [];
        // Upsert: update existing or append new
        const found = existing.some((o) => o.role_id === override.role_id);
        const updated = found
          ? existing.map((o) =>
              o.role_id === override.role_id ? override : o
            )
          : [...existing, override];

        return {
          overridesByChannel: {
            ...state.overridesByChannel,
            [override.channel_id]: updated,
          },
        };
      });
    },

    handleOverrideDelete: (channelID, roleID) => {
      set((state) => {
        const existing = state.overridesByChannel[channelID];
        if (!existing) return state;

        return {
          overridesByChannel: {
            ...state.overridesByChannel,
            [channelID]: existing.filter((o) => o.role_id !== roleID),
          },
        };
      });
    },
  })
);
