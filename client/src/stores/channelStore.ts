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
  /** Optimistic kanal sıralama — anında UI günceller, sonra API çağırır.
   * category_id opsiyonel — cross-category drag-and-drop için. */
  reorderChannels: (items: { id: string; position: number; category_id?: string }[]) => Promise<boolean>;
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

      // Eğer hedef kategori bulunamadıysa (örn. kategorisiz kanal ve
      // henüz uncategorized grubu yoksa), yeni bir sanal grup oluştur.
      if (!found) {
        if (targetCatId === "") {
          // Kategorisiz: en başa uncategorized grup ekle
          categories.unshift({
            category: { id: "", name: "", position: -1 },
            channels: [channel],
          });
        } else if (categories.length > 0) {
          // Bilinmeyen kategori: ilk gruba fallback (eski davranış)
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

    // Cross-category taşıma var mı kontrol et
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
      // Cross-category: kanalı kaynak category'den çıkar, hedef category'ye ekle
      set((state) => {
        // Tüm kanalları flat topla (taşınan kanalın bilgisine ihtiyacımız var)
        const allChannels = state.categories.flatMap((cg) => cg.channels);

        // Her category'nin kanallarını yeniden hesapla
        const newCategories = state.categories.map((cg) => {
          const catId = cg.category.id;

          // Bu category'ye ait olacak kanalları hesapla:
          // 1. Mevcut kanallar (taşınanlar hariç)
          // 2. Bu category'ye taşınan kanallar
          let channels = cg.channels.filter(
            (ch) => !categoryChangeMap.has(ch.id)
          );

          // Bu category'ye taşınan kanalları ekle
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

          // Position güncelle ve sırala
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
      // Same-category: sadece position güncelle (mevcut davranış)
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

  clearForServerSwitch: () => {
    set({ categories: [], selectedChannelId: null, isLoading: false });
  },
}));
