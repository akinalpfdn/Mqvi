/**
 * Channel Store — Channel and category state management.
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
  categories: CategoryWithChannels[];
  selectedChannelId: string | null;
  isLoading: boolean;
  mutedChannelIds: Set<string>;

  // ─── Actions ───
  fetchChannels: () => Promise<void>;
  selectChannel: (channelId: string) => void;

  // ─── Channel Mute ───
  setMutedChannelsFromReady: (ids: string[]) => void;
  muteChannel: (channelId: string, duration: string) => Promise<boolean>;
  unmuteChannel: (channelId: string) => Promise<boolean>;

  // ─── WS Event Handlers ───
  handleChannelCreate: (channel: Channel) => void;
  handleChannelUpdate: (channel: Channel) => void;
  handleChannelDelete: (channelId: string) => void;
  handleCategoryCreate: (category: Category) => void;
  handleCategoryUpdate: (category: Category) => void;
  handleCategoryDelete: (categoryId: string) => void;

  // ─── Reorder ───
  reorderChannels: (items: { id: string; position: number; category_id?: string }[]) => Promise<boolean>;
  handleChannelReorder: (categories: CategoryWithChannels[]) => void;

  clearForServerSwitch: () => void;
};

export const useChannelStore = create<ChannelState>((set, get) => ({
  categories: [],
  selectedChannelId: null,
  isLoading: false,
  mutedChannelIds: new Set<string>(),

  fetchChannels: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    set({ isLoading: true });

    const res = await channelApi.getChannels(serverId);
    if (res.success && res.data) {
      const state = get();
      let selectedChannelId = state.selectedChannelId;

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
      const targetCatId = channel.category_id ?? "";
      let found = false;

      const categories = state.categories.map((cg) => {
        if (cg.category.id === targetCatId) {
          found = true;
          return {
            ...cg,
            channels: [...cg.channels, channel],
          };
        }
        return cg;
      });

      // If target category not found, create virtual uncategorized group or fallback
      if (!found) {
        if (targetCatId === "") {
          categories.unshift({
            category: { id: "", name: "", position: -1 },
            channels: [channel],
          });
        } else if (categories.length > 0) {
          const first = { ...categories[0] };
          first.channels = [...first.channels, channel];
          categories[0] = first;
        }
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

    // Check for cross-category moves
    const categoryChangeMap = new Map<string, string>();
    for (const item of items) {
      if (item.category_id !== undefined) {
        categoryChangeMap.set(item.id, item.category_id);
      }
    }
    const hasCategoryChange = categoryChangeMap.size > 0;

    // Optimistic update
    const positionMap = new Map(items.map((item) => [item.id, item.position]));

    if (hasCategoryChange) {
      set((state) => {
        const allChannels = state.categories.flatMap((cg) => cg.channels);

        const newCategories = state.categories.map((cg) => {
          const catId = cg.category.id;

          let channels = cg.channels.filter(
            (ch) => !categoryChangeMap.has(ch.id)
          );

          // Add channels moved to this category
          for (const [chId, targetCatId] of categoryChangeMap) {
            if (targetCatId === catId) {
              const ch = allChannels.find((c) => c.id === chId);
              if (ch) {
                channels.push({
                  ...ch,
                  category_id: targetCatId || null,
                });
              }
            }
          }

          channels = channels
            .map((ch) => {
              const newPos = positionMap.get(ch.id);
              return newPos !== undefined ? { ...ch, position: newPos } : ch;
            })
            .sort((a, b) => a.position - b.position);

          return { ...cg, channels };
        });

        return { categories: newCategories };
      });
    } else {
      // Same-category reorder
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
    }

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

  // ─── Channel Mute ───

  setMutedChannelsFromReady: (ids) => {
    set({ mutedChannelIds: new Set(ids) });
  },

  muteChannel: async (channelId, duration) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await channelApi.muteChannel(serverId, channelId, duration);
    if (res.success) {
      set((state) => {
        const next = new Set(state.mutedChannelIds);
        next.add(channelId);
        return { mutedChannelIds: next };
      });
      return true;
    }
    return false;
  },

  unmuteChannel: async (channelId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await channelApi.unmuteChannel(serverId, channelId);
    if (res.success) {
      set((state) => {
        const next = new Set(state.mutedChannelIds);
        next.delete(channelId);
        return { mutedChannelIds: next };
      });
      return true;
    }
    return false;
  },

  clearForServerSwitch: () => {
    set({ categories: [], selectedChannelId: null, isLoading: false });
  },
}));
