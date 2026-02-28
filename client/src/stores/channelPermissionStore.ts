/**
 * Channel Permission Store — Zustand ile kanal bazlı permission override yönetimi.
 *
 * Bu store:
 * - Kanal bazlı override'ları bellekte tutar (channelId → override[])
 * - API üzerinden CRUD operasyonları
 * - WS event'leri ile gerçek zamanlı güncelleme
 *
 * Veri yapısı: Map<channelId, ChannelPermissionOverride[]>
 * Bir kanalın override'ları ilk kez istendiğinde fetch edilir ve cache'lenir.
 */

import { create } from "zustand";
import * as channelPermApi from "../api/channelPermissions";
import { useServerStore } from "./serverStore";
import type { ChannelPermissionOverride } from "../types";

/** Boş override dizisi — selector'larda stable ref sağlar */
const EMPTY_OVERRIDES: ChannelPermissionOverride[] = [];

type ChannelPermissionState = {
  /**
   * channelId → override listesi.
   * Record (düz obje) kullanıyoruz — Map yerine, çünkü
   * Zustand immutable update'lerde obje spread daha kolay.
   */
  overridesByChannel: Record<string, ChannelPermissionOverride[]>;

  /** Hangi kanallar zaten fetch edildi? (tekrar fetch önleme) */
  fetchedChannels: Set<string>;

  // ─── Actions ───

  /** Bir kanalın override'larını API'den getirir (cache-first) */
  fetchOverrides: (channelID: string) => Promise<void>;

  /** Override oluştur/güncelle — başarılıysa true döner */
  setOverride: (
    channelID: string,
    roleID: string,
    allow: number,
    deny: number
  ) => Promise<boolean>;

  /** Override sil — başarılıysa true döner */
  deleteOverride: (channelID: string, roleID: string) => Promise<boolean>;

  /** Bir kanalın override'larını döner (stable ref, selector'da kullan) */
  getOverrides: (channelID: string) => ChannelPermissionOverride[];

  // ─── WS Event Handlers ───

  /** channel_permission_update WS event'i */
  handleOverrideUpdate: (override: ChannelPermissionOverride) => void;

  /** channel_permission_delete WS event'i */
  handleOverrideDelete: (channelID: string, roleID: string) => void;
};

export const useChannelPermissionStore = create<ChannelPermissionState>(
  (set, get) => ({
    overridesByChannel: {},
    fetchedChannels: new Set(),

    fetchOverrides: async (channelID) => {
      // Cache hit — zaten yüklenmiş
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
      // WS broadcast ile state güncellenecek — duplicate guard handleOverrideUpdate'de
      return !!res.data;
    },

    deleteOverride: async (channelID, roleID) => {
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return false;
      const res = await channelPermApi.deleteOverride(serverId, channelID, roleID);
      // WS broadcast ile state güncellenecek
      return !!res.data;
    },

    getOverrides: (channelID) => {
      return get().overridesByChannel[channelID] ?? EMPTY_OVERRIDES;
    },

    // ─── WS Event Handlers ───

    handleOverrideUpdate: (override) => {
      set((state) => {
        const existing = state.overridesByChannel[override.channel_id] ?? [];
        // Mevcut override varsa güncelle, yoksa ekle (upsert)
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
