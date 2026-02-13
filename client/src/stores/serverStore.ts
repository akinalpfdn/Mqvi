/**
 * Server Store — Zustand ile sunucu bilgisi yönetimi.
 *
 * Tek sunucu mimarisi: Uygulamada her zaman tek bir sunucu vardır.
 * Bu store sunucu adı ve ikonunu tutar.
 *
 * Güncellenme yolları:
 * 1. App başlatıldığında fetchServer() ile API'den çekilir
 * 2. WS server_update event'i ile gerçek zamanlı güncellenir
 *    (başka bir admin sunucu adını değiştirirse anında yansır)
 *
 * Sidebar header bu store'dan sunucu adını okur.
 */

import { create } from "zustand";
import * as serverApi from "../api/server";
import type { Server } from "../types";

type ServerState = {
  /** Sunucu bilgisi — null ise henüz yüklenmemiş */
  server: Server | null;

  /** Sunucu bilgisini API'den çek */
  fetchServer: () => Promise<void>;

  /** WS server_update event handler — sunucu bilgisini günceller */
  handleServerUpdate: (server: Server) => void;
};

export const useServerStore = create<ServerState>((set) => ({
  server: null,

  fetchServer: async () => {
    const res = await serverApi.getServer();
    if (res.success && res.data) {
      set({ server: res.data });
    }
  },

  handleServerUpdate: (server) => {
    set({ server });
  },
}));
