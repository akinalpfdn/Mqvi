/**
 * Channel Store — Zustand ile kanal ve kategori state yönetimi.
 *
 * Bu store kanalları ve kategorileri yönetir:
 * - Backend'den fetch edip cache'ler
 * - Seçili kanalı takip eder
 * - WebSocket event'leri ile gerçek zamanlı güncellenir
 *
 * Multi-server: fetchChannels activeServerId'ye göre server-scoped API çağrısı yapar.
 * Server değiştirildiğinde dışarıdan fetchChannels() çağrılır (cascade refetch).
 */

import { create } from "zustand";
import * as channelApi from "../api/channels";
import { useServerStore } from "./serverStore";
import type {
  Channel,
  Category,
  CategoryWithChannels,
} from "../types";

type ChannelState = {
  /** Kategorilere göre gruplanmış kanallar */
  categories: CategoryWithChannels[];
  /** Seçili kanal ID'si */
  selectedChannelId: string | null;
  /** Yüklenme durumu */
  isLoading: boolean;

  // ─── Actions ───
  fetchChannels: () => Promise<void>;
  selectChannel: (channelId: string) => void;

  // ─── WS Event Handlers ───
  handleChannelCreate: (channel: Channel) => void;
  handleChannelUpdate: (channel: Channel) => void;
  handleChannelDelete: (channelId: string) => void;
  handleCategoryCreate: (category: Category) => void;
  handleCategoryUpdate: (category: Category) => void;
  handleCategoryDelete: (categoryId: string) => void;

  // ─── Reorder ───
  /** Optimistic kanal sıralama — anında UI günceller, sonra API çağırır */
  reorderChannels: (items: { id: string; position: number }[]) => Promise<boolean>;
  /** WS channel_reorder event handler — store'u tam listeyle replace eder */
  handleChannelReorder: (categories: CategoryWithChannels[]) => void;

  /** Server değiştirildiğinde store'u temizler */
  clearForServerSwitch: () => void;
};

export const useChannelStore = create<ChannelState>((set, get) => ({
  categories: [],
  selectedChannelId: null,
  isLoading: false,

  /**
   * fetchChannels — Backend'den aktif sunucunun kanallarını çeker.
   *
   * Multi-server: serverStore'dan activeServerId alır ve
   * GET /api/servers/{serverId}/channels çağırır.
   * Server yoksa erken dönüş.
   */
  fetchChannels: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    set({ isLoading: true });

    const res = await channelApi.getChannels(serverId);
    if (res.success && res.data) {
      const state = get();
      let selectedChannelId = state.selectedChannelId;

      // Seçili kanal hala görünür listede mi?
      const allVisible = res.data.flatMap((cg) => cg.channels);

      if (selectedChannelId) {
        const stillVisible = allVisible.some((ch) => ch.id === selectedChannelId);
        if (!stillVisible) {
          const firstText = allVisible.find((ch) => ch.type === "text");
          selectedChannelId = firstText?.id ?? null;
        }
      } else {
        const firstText = allVisible.find((ch) => ch.type === "text");
        if (firstText) {
          selectedChannelId = firstText.id;
        }
      }

      set({ categories: res.data, isLoading: false, selectedChannelId });
    } else {
      set({ isLoading: false });
    }
  },

  selectChannel: (channelId) => {
    set({ selectedChannelId: channelId });
  },

  // ─── WebSocket Event Handlers ───

  handleChannelCreate: (channel) => {
    set((state) => {
      const categories = state.categories.map((cg) => {
        if (cg.category.id === (channel.category_id ?? "")) {
          return {
            ...cg,
            channels: [...cg.channels, channel],
          };
        }
        return cg;
      });

      const found = categories.some((cg) =>
        cg.channels.some((ch) => ch.id === channel.id)
      );
      if (!found && categories.length > 0) {
        const first = { ...categories[0] };
        first.channels = [...first.channels, channel];
        categories[0] = first;
      }

      return { categories };
    });
  },

  handleChannelUpdate: (channel) => {
    set((state) => ({
      categories: state.categories.map((cg) => ({
        ...cg,
        channels: cg.channels.map((ch) =>
          ch.id === channel.id ? channel : ch
        ),
      })),
    }));
  },

  handleChannelDelete: (channelId) => {
    set((state) => {
      const categories = state.categories.map((cg) => ({
        ...cg,
        channels: cg.channels.filter((ch) => ch.id !== channelId),
      }));

      let selectedChannelId = state.selectedChannelId;
      if (selectedChannelId === channelId) {
        const firstTextChannel = categories
          .flatMap((cg) => cg.channels)
          .find((ch) => ch.type === "text");
        selectedChannelId = firstTextChannel?.id ?? null;
      }

      return { categories, selectedChannelId };
    });
  },

  handleCategoryCreate: (category) => {
    set((state) => ({
      categories: [
        ...state.categories,
        { category, channels: [] },
      ],
    }));
  },

  handleCategoryUpdate: (category) => {
    set((state) => ({
      categories: state.categories.map((cg) =>
        cg.category.id === category.id
          ? { ...cg, category }
          : cg
      ),
    }));
  },

  handleCategoryDelete: (categoryId) => {
    set((state) => ({
      categories: state.categories.filter(
        (cg) => cg.category.id !== categoryId
      ),
    }));
  },

  // ─── Reorder ───

  reorderChannels: async (items) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const prevCategories = get().categories;

    // Optimistic update
    const positionMap = new Map(items.map((item) => [item.id, item.position]));
    set((state) => ({
      categories: state.categories.map((cg) => ({
        ...cg,
        channels: cg.channels
          .map((ch) => {
            const newPos = positionMap.get(ch.id);
            return newPos !== undefined ? { ...ch, position: newPos } : ch;
          })
          .sort((a, b) => a.position - b.position),
      })),
    }));

    const res = await channelApi.reorderChannels(serverId, items);
    if (!res.success) {
      set({ categories: prevCategories });
      return false;
    }

    return true;
  },

  handleChannelReorder: (categories) => {
    set({ categories });
  },

  clearForServerSwitch: () => {
    set({ categories: [], selectedChannelId: null, isLoading: false });
  },
}));
