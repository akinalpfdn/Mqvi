/**
 * Channel Store — Zustand ile kanal ve kategori state yönetimi.
 *
 * Bu store kanalları ve kategorileri yönetir:
 * - Backend'den fetch edip cache'ler
 * - Seçili kanalı takip eder
 * - WebSocket event'leri ile gerçek zamanlı güncellenir
 *
 * Store'un WebSocket ile entegrasyonu:
 * useWebSocket hook'u WS event geldiğinde bu store'un handler'larını çağırır.
 * Store → API çağrısı yapar, WS → Store'u günceller (tek yönlü akış).
 */

import { create } from "zustand";
import * as channelApi from "../api/channels";
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
};

export const useChannelStore = create<ChannelState>((set, get) => ({
  categories: [],
  selectedChannelId: null,
  isLoading: false,

  /**
   * fetchChannels — Backend'den kullanıcının görebileceği kanalları çeker.
   *
   * Backend ViewChannel yetkisine göre filtreler — yetki olmayan kanallar dönmez.
   * Çağrıldığında seçili kanalın hala görünür olup olmadığını kontrol eder:
   * - Seçili kanal artık görünür değilse → ilk görünür text kanala geçiş yapar
   * - Bu sayede ViewChannel deny edildiğinde kullanıcı otomatik yönlendirilir
   */
  fetchChannels: async () => {
    set({ isLoading: true });

    const res = await channelApi.getChannels();
    if (res.success && res.data) {
      const state = get();
      let selectedChannelId = state.selectedChannelId;

      // Seçili kanal hala görünür listede mi?
      const allVisible = res.data.flatMap((cg) => cg.channels);

      if (selectedChannelId) {
        const stillVisible = allVisible.some((ch) => ch.id === selectedChannelId);
        if (!stillVisible) {
          // Seçili kanal artık görünür değil → ilk görünür text kanala geç
          const firstText = allVisible.find((ch) => ch.type === "text");
          selectedChannelId = firstText?.id ?? null;
        }
      } else {
        // İlk yüklemede: seçili kanal yoksa ilk text kanalını otomatik seç
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
  //
  // Bu handler'lar WebSocket'ten gelen event'leri store state'ine yansıtır.
  // Böylece bir kullanıcı kanal oluşturduğunda diğer kullanıcıların
  // sidebar'ı anında güncellenir (refetch gerekmez).

  handleChannelCreate: (channel) => {
    set((state) => {
      const categories = state.categories.map((cg) => {
        // Kanalın ait olduğu kategoriyi bul ve ekle
        if (cg.category.id === (channel.category_id ?? "")) {
          return {
            ...cg,
            channels: [...cg.channels, channel],
          };
        }
        return cg;
      });

      // Eğer kanal uncategorized ise (category_id = null)
      // ve "uncategorized" grubu yoksa, channels'ın ilk grubuna ekle
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

      // Silinen kanal seçili ise, başka bir kanala geç
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

  /**
   * reorderChannels — Kanal sıralamasını optimistic olarak günceller.
   *
   * Akış:
   * 1. Mevcut categories'ı kaydet (revert için)
   * 2. items'daki position değerlerini store'a anında yansıt (optimistic update)
   * 3. API çağrısı yap
   * 4. Hata olursa eski state'e geri dön (revert)
   *
   * WS broadcast sonucu zaten handleChannelReorder ile gelecek —
   * optimistic update sayesinde kullanıcı gecikme hissetmez.
   */
  reorderChannels: async (items) => {
    const prevCategories = get().categories;

    // Optimistic update — position değerlerini anında uygula
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

    const res = await channelApi.reorderChannels(items);
    if (!res.success) {
      // API hatası — eski state'e geri dön
      set({ categories: prevCategories });
      return false;
    }

    return true;
  },

  /**
   * handleChannelReorder — WS channel_reorder event handler.
   * Backend'den gelen tam CategoryWithChannels[] listesiyle store'u replace eder.
   * Bu sayede tüm client'lar aynı sıraya gelir.
   */
  handleChannelReorder: (categories) => {
    set({ categories });
  },
}));
