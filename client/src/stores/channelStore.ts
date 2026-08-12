/**
 * Channel Store — Channel and category state management.
 */

import { create } from "zustand";
import * as channelApi from "../api/channels";
import { useServerStore } from "./serverStore";
import { useUIStore } from "./uiStore";
import { useVoiceStore } from "./voiceStore";
import type {
  Channel,
  Category,
  CategoryWithChannels,
} from "../types";

type ChannelState = {
  categories: CategoryWithChannels[];
  /** Per-server channel-tree cache. Lets a re-visited server paint instantly while it revalidates. */
  categoriesByServer: Record<string, CategoryWithChannels[]>;
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

  // ─── Mutations ───
  // These exist so the tree updates on the acting client without waiting for the WS echo. Each one
  // applies its result through the same handler the echo uses, so the two paths cannot drift.
  createChannel: (data: {
    name: string;
    type: Channel["type"];
    category_id?: string;
  }) => Promise<Channel | null>;
  updateChannel: (channelId: string, data: { name?: string; category_id?: string }) => Promise<boolean>;
  deleteChannel: (channelId: string) => Promise<boolean>;
  createCategory: (name: string) => Promise<Category | null>;
  updateCategory: (categoryId: string, data: { name?: string }) => Promise<boolean>;
  deleteCategory: (categoryId: string) => Promise<boolean>;

  // ─── WS Event Handlers ───
  handleChannelCreate: (channel: Channel) => void;
  handleChannelUpdate: (channel: Channel) => void;
  handleChannelDelete: (channelId: string) => void;
  handleCategoryCreate: (category: Category) => void;
  handleCategoryUpdate: (category: Category) => void;
  handleCategoryDelete: (categoryId: string) => void;

  // ─── Reorder ───
  reorderChannels: (items: { id: string; position: number; category_id?: string }[]) => Promise<boolean>;
  reorderCategories: (items: { id: string; position: number }[]) => Promise<boolean>;
  handleChannelReorder: (categories: CategoryWithChannels[]) => void;
  handleCategoryReorder: () => void;

  /** Snapshot the outgoing server's tree, then paint the incoming server from cache. */
  switchToServer: (serverId: string) => void;
  /** Paint the current server from cache (used when activeServerId changed without switchToServer). */
  hydrateFromCache: () => void;
  /** Drop a server's cached tree — call when leaving/deleting it so the cache can't grow unbounded. */
  evictServerCache: (serverId: string) => void;
  clearForServerSwitch: () => void;
};

export const useChannelStore = create<ChannelState>((set, get) => ({
  categories: [],
  categoriesByServer: {},
  selectedChannelId: null,
  isLoading: false,
  mutedChannelIds: new Set<string>(),

  fetchChannels: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    // Only show the loading state when there's nothing cached to paint — a background
    // revalidation must not blank a tree we're already showing from cache.
    set({ isLoading: get().categories.length === 0 });

    const res = await channelApi.getChannels(serverId);
    if (res.success && res.data) {
      const state = get();
      let selectedChannelId = state.selectedChannelId;

      const allVisible = res.data.flatMap((cg) => cg.channels);

      // Drop selection if the channel is no longer visible (deleted, hidden, or
      // belongs to a different server). Don't auto-select a default — the user
      // chooses which channel to open.
      if (selectedChannelId && !allVisible.some((ch) => ch.id === selectedChannelId)) {
        selectedChannelId = null;
      }

      // Cache is always keyed by the server we actually fetched. But only swap the live tree if
      // that server is still active — otherwise a slow fetch resolving after a switch would
      // clobber the new server's channels.
      const stillActive = useServerStore.getState().activeServerId === serverId;
      set({
        categoriesByServer: { ...state.categoriesByServer, [serverId]: res.data },
        ...(stillActive ? { categories: res.data, isLoading: false, selectedChannelId } : {}),
      });
    } else if (useServerStore.getState().activeServerId === serverId) {
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

      // Drop any existing copy before inserting. The creating client now applies this itself and
      // the echo replays it moments later; appending blindly would show the channel twice. Also
      // covers a genuine duplicate event from a reconnect.
      const stripped = state.categories.map((cg) => {
        const channels = cg.channels.filter((ch) => ch.id !== channel.id);
        return channels.length === cg.channels.length ? cg : { ...cg, channels };
      });

      const categories = stripped.map((cg) => {
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
    // An open tab keeps its own copy of the label. This used to live in the WS handler, which left
    // the acting client's tab showing the old name until the echo came back.
    useUIStore.getState().updateTabLabel(channel.id, channel.name);
  },

  handleChannelDelete: (channelId) => {
    // The channel is gone server-side, so a LiveKit session in it has nothing to talk to. Also
    // previously WS-only, meaning the person who deleted it stayed connected until the echo.
    if (useVoiceStore.getState().currentVoiceChannelId === channelId) {
      useVoiceStore.getState().handleForceDisconnect();
    }

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
    set((state) => {
      // Same idempotency as handleChannelCreate. Replace rather than re-append, and keep the
      // channels already grouped under it — a blind `{ category, channels: [] }` would empty them.
      if (state.categories.some((cg) => cg.category.id === category.id)) {
        return {
          categories: state.categories.map((cg) =>
            cg.category.id === category.id ? { ...cg, category } : cg
          ),
        };
      }
      return { categories: [...state.categories, { category, channels: [] }] };
    });
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

  reorderCategories: async (items) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const prevCategories = get().categories;

    // Optimistic update
    const positionMap = new Map(items.map((item) => [item.id, item.position]));
    set((state) => ({
      categories: [...state.categories]
        .map((cg) => {
          const newPos = positionMap.get(cg.category.id);
          return newPos !== undefined
            ? { ...cg, category: { ...cg.category, position: newPos } }
            : cg;
        })
        .sort((a, b) => a.category.position - b.category.position),
    }));

    const res = await channelApi.reorderCategories(serverId, items);
    if (!res.success) {
      set({ categories: prevCategories });
      return false;
    }

    return true;
  },

  handleChannelReorder: (categories) => {
    set({ categories });
  },

  /** Re-fetch channels to get updated category order from server */
  handleCategoryReorder: () => {
    get().fetchChannels();
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

  // ─── Mutations ───

  createChannel: async (data) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return null;

    const res = await channelApi.createChannel(serverId, data);
    if (!res.success || !res.data) return null;

    get().handleChannelCreate(res.data);
    return res.data;
  },

  updateChannel: async (channelId, data) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await channelApi.updateChannel(serverId, channelId, data);
    if (!res.success || !res.data) return false;

    get().handleChannelUpdate(res.data);
    return true;
  },

  deleteChannel: async (channelId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await channelApi.deleteChannel(serverId, channelId);
    if (!res.success) return false;

    get().handleChannelDelete(channelId);
    return true;
  },

  createCategory: async (name) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return null;

    const res = await channelApi.createCategory(serverId, { name });
    if (!res.success || !res.data) return null;

    get().handleCategoryCreate(res.data);
    return res.data;
  },

  updateCategory: async (categoryId, data) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await channelApi.updateCategory(serverId, categoryId, data);
    if (!res.success || !res.data) return false;

    get().handleCategoryUpdate(res.data);
    return true;
  },

  deleteCategory: async (categoryId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await channelApi.deleteCategory(serverId, categoryId);
    if (!res.success) return false;

    get().handleCategoryDelete(categoryId);
    return true;
  },

  switchToServer: (serverId) => {
    const oldId = useServerStore.getState().activeServerId; // still the outgoing server here
    const { categories, categoriesByServer } = get();
    const cache = oldId ? { ...categoriesByServer, [oldId]: categories } : categoriesByServer;
    const next = cache[serverId] ?? [];
    set({
      categoriesByServer: cache,
      categories: next,
      selectedChannelId: null,
      isLoading: next.length === 0,
    });
  },

  hydrateFromCache: () => {
    const serverId = useServerStore.getState().activeServerId;
    const cached = serverId ? (get().categoriesByServer[serverId] ?? []) : [];
    set({ categories: cached, selectedChannelId: null, isLoading: cached.length === 0 });
  },

  evictServerCache: (serverId) => {
    set((state) => {
      if (!(serverId in state.categoriesByServer)) return state;
      const next = { ...state.categoriesByServer };
      delete next[serverId];
      return { categoriesByServer: next };
    });
  },

  clearForServerSwitch: () => {
    set({ categories: [], selectedChannelId: null, isLoading: false });
  },
}));
