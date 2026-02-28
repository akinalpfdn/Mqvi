/**
 * Server Store — Zustand ile çoklu sunucu yönetimi.
 *
 * Multi-server mimaride kullanıcı birden fazla sunucuya üye olabilir.
 * Bu store:
 * - Kullanıcının tüm sunucu listesini tutar (sidebar icon listesi)
 * - Aktif sunucuyu takip eder (tüm server-scoped store'lar buna bağlı)
 * - Sunucu oluşturma, katılma, ayrılma işlemlerini yönetir
 * - WS event'leri ile gerçek zamanlı güncellenir
 *
 * Server değiştirince cascade refetch:
 * setActiveServer çağrıldığında channelStore, memberStore, roleStore, readStateStore
 * otomatik olarak yeni sunucunun verilerini fetch eder. Bu, her store'un
 * fetchXxx fonksiyonunun activeServerId'yi kullanmasıyla sağlanır.
 */

import { create } from "zustand";
import * as serversApi from "../api/servers";
import { useChannelStore } from "./channelStore";
import { useMemberStore } from "./memberStore";
import { useRoleStore } from "./roleStore";
import { useReadStateStore } from "./readStateStore";
import type { Server, ServerListItem, CreateServerRequest } from "../types";

/** localStorage key — son aktif sunucu ID'si (sayfa yenileme sonrası kurtarma) */
const LAST_SERVER_KEY = "mqvi_last_server";

type ServerState = {
  /** Kullanıcının üye olduğu sunucu listesi (sidebar) */
  servers: ServerListItem[];
  /** Aktif sunucu ID'si — tüm server-scoped store'lar buna bağlı */
  activeServerId: string | null;
  /** Aktif sunucunun tam bilgisi (detay sayfası, settings için) */
  activeServer: Server | null;
  /** Yüklenme durumu */
  isLoading: boolean;

  // ─── Actions ───

  /** WS ready event'inden gelen sunucu listesini set eder */
  setServersFromReady: (servers: ServerListItem[]) => void;

  /** API'den sunucu listesini çeker */
  fetchServers: () => Promise<void>;

  /**
   * Aktif sunucuyu değiştirir.
   *
   * Bu fonksiyon çağrıldığında:
   * 1. activeServerId güncellenir
   * 2. localStorage'a persist edilir
   *
   * Cascade refetch çağıran tarafta (AppLayout/ServerListSidebar)
   * yapılır — böylece store'lar arası circular dependency önlenir.
   */
  setActiveServer: (serverId: string) => void;

  /** Aktif sunucunun detayını API'den çeker */
  fetchActiveServer: () => Promise<void>;

  /** Yeni sunucu oluşturur */
  createServer: (req: CreateServerRequest) => Promise<Server | null>;

  /** Davet koduyla sunucuya katılır */
  joinServer: (inviteCode: string) => Promise<Server | null>;

  /** Sunucudan ayrılır */
  leaveServer: (serverId: string) => Promise<boolean>;

  /** Sunucuyu siler (owner only) */
  deleteServer: (serverId: string) => Promise<boolean>;

  // ─── WS Event Handlers ───

  /** server_update — sunucu bilgisi güncellendi */
  handleServerUpdate: (server: Server) => void;

  /** server_create — kullanıcı yeni sunucuya katıldı veya oluşturdu */
  handleServerCreate: (server: ServerListItem) => void;

  /** server_delete — sunucu silindi veya kullanıcı ayrıldı */
  handleServerDelete: (serverId: string) => void;
};

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: localStorage.getItem(LAST_SERVER_KEY),
  activeServer: null,
  isLoading: false,

  setServersFromReady: (servers) => {
    set({ servers });
    // Eğer aktif sunucu yoksa veya aktif sunucu listede yoksa, ilk sunucuyu seç
    const state = get();
    if (servers.length > 0) {
      const savedId = state.activeServerId;
      const exists = savedId && servers.some((s) => s.id === savedId);
      if (!exists) {
        const firstServer = servers[0];
        set({ activeServerId: firstServer.id });
        localStorage.setItem(LAST_SERVER_KEY, firstServer.id);
      }
    }
  },

  fetchServers: async () => {
    set({ isLoading: true });
    const res = await serversApi.getMyServers();
    if (res.success && res.data) {
      set({ servers: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  setActiveServer: (serverId) => {
    // Server-scoped store'ları hemen temizle — böylece ChannelTree
    // yeniden render olduğunda eski sunucunun kanalları gösterilmez.
    // AppLayout'taki useEffect de cascadeRefetch yapar (clear + fetch),
    // ama useEffect render SONRASI çalışır — o ana kadar eski veri
    // yeni sunucu altında görünebilir. Bu early-clear bunu engeller.
    useChannelStore.getState().clearForServerSwitch();
    useMemberStore.getState().clearForServerSwitch();
    useRoleStore.getState().clearForServerSwitch();
    useReadStateStore.getState().clearForServerSwitch();

    set({ activeServerId: serverId, activeServer: null });
    localStorage.setItem(LAST_SERVER_KEY, serverId);
  },

  fetchActiveServer: async () => {
    const serverId = get().activeServerId;
    if (!serverId) return;

    const res = await serversApi.getServer(serverId);
    if (res.success && res.data) {
      set({ activeServer: res.data });
    }
  },

  createServer: async (req) => {
    const res = await serversApi.createServer(req);
    if (res.success && res.data) {
      const server = res.data;
      // Sunucu listesine ekle + aktif sunucu olarak set et (atomik)
      // WS server_create event de gelecek ama race condition'a karşı burada da ekle
      set((state) => {
        const servers = state.servers.some((s) => s.id === server.id)
          ? state.servers
          : [...state.servers, { id: server.id, name: server.name, icon_url: server.icon_url }];
        return {
          servers,
          activeServerId: server.id,
          activeServer: server,
        };
      });
      localStorage.setItem(LAST_SERVER_KEY, server.id);
      return server;
    }
    return null;
  },

  joinServer: async (inviteCode) => {
    const res = await serversApi.joinServer(inviteCode);
    if (res.success && res.data) {
      const server = res.data;
      // Sunucu listesine ekle + aktif sunucu olarak set et (atomik)
      // WS server_create event de gelecek
      set((state) => {
        const servers = state.servers.some((s) => s.id === server.id)
          ? state.servers
          : [...state.servers, { id: server.id, name: server.name, icon_url: server.icon_url }];
        return {
          servers,
          activeServerId: server.id,
          activeServer: server,
        };
      });
      localStorage.setItem(LAST_SERVER_KEY, server.id);
      return server;
    }
    return null;
  },

  leaveServer: async (serverId) => {
    const res = await serversApi.leaveServer(serverId);
    if (res.success) {
      // WS server_delete event de gelecek
      set((state) => {
        const servers = state.servers.filter((s) => s.id !== serverId);
        let activeServerId = state.activeServerId;
        if (activeServerId === serverId) {
          activeServerId = servers[0]?.id ?? null;
          if (activeServerId) {
            localStorage.setItem(LAST_SERVER_KEY, activeServerId);
          } else {
            localStorage.removeItem(LAST_SERVER_KEY);
          }
        }
        return { servers, activeServerId, activeServer: null };
      });
      return true;
    }
    return false;
  },

  deleteServer: async (serverId) => {
    const res = await serversApi.deleteServer(serverId);
    if (res.success) {
      // WS server_delete event de gelecek
      set((state) => {
        const servers = state.servers.filter((s) => s.id !== serverId);
        let activeServerId = state.activeServerId;
        if (activeServerId === serverId) {
          activeServerId = servers[0]?.id ?? null;
          if (activeServerId) {
            localStorage.setItem(LAST_SERVER_KEY, activeServerId);
          } else {
            localStorage.removeItem(LAST_SERVER_KEY);
          }
        }
        return { servers, activeServerId, activeServer: null };
      });
      return true;
    }
    return false;
  },

  // ─── WS Event Handlers ───

  handleServerUpdate: (server) => {
    set((state) => {
      // Sunucu listesindeki bilgiyi güncelle
      const servers = state.servers.map((s) =>
        s.id === server.id
          ? { id: server.id, name: server.name, icon_url: server.icon_url }
          : s
      );
      // Aktif sunucu ise detayı da güncelle
      const activeServer =
        state.activeServer?.id === server.id ? server : state.activeServer;
      return { servers, activeServer };
    });
  },

  handleServerCreate: (server) => {
    set((state) => {
      if (state.servers.some((s) => s.id === server.id)) return state;
      return { servers: [...state.servers, server] };
    });
  },

  handleServerDelete: (serverId) => {
    set((state) => {
      const servers = state.servers.filter((s) => s.id !== serverId);
      let activeServerId = state.activeServerId;
      if (activeServerId === serverId) {
        activeServerId = servers[0]?.id ?? null;
        if (activeServerId) {
          localStorage.setItem(LAST_SERVER_KEY, activeServerId);
        } else {
          localStorage.removeItem(LAST_SERVER_KEY);
        }
      }
      return { servers, activeServerId, activeServer: null };
    });
  },
}));
