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
};

export const useChannelStore = create<ChannelState>((set, get) => ({
  categories: [],
  selectedChannelId: null,
  isLoading: false,

  /**
   * fetchChannels — Backend'den tüm kanalları kategorilere göre gruplu çeker.
   * Uygulama başladığında ve sidebar mount edildiğinde çağrılır.
   */
  fetchChannels: async () => {
    set({ isLoading: true });

    const res = await channelApi.getChannels();
    if (res.success && res.data) {
      set({ categories: res.data, isLoading: false });

      // İlk yüklemede: seçili kanal yoksa ilk text kanalını otomatik seç
      const state = get();
      if (!state.selectedChannelId) {
        const firstTextChannel = res.data
          .flatMap((cg) => cg.channels)
          .find((ch) => ch.type === "text");
        if (firstTextChannel) {
          set({ selectedChannelId: firstTextChannel.id });
        }
      }
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
}));
