/**
 * Server Store — Multi-server state management.
 */

import { create } from "zustand";
import * as serversApi from "../api/servers";
import { useChannelStore } from "./channelStore";
import { useMemberStore } from "./memberStore";
import { useRoleStore } from "./roleStore";
import { useReadStateStore } from "./readStateStore";
import { useE2EEStore } from "./e2eeStore";
import type { Server, ServerListItem, CreateServerRequest } from "../types";

/** Persist last active server across page reloads */
const LAST_SERVER_KEY = "mqvi_last_server";

type ServerState = {
  servers: ServerListItem[];
  /** All server-scoped stores depend on this */
  activeServerId: string | null;
  activeServer: Server | null;
  isLoading: boolean;
  mutedServerIds: Set<string>;

  // ─── Actions ───

  setServersFromReady: (servers: ServerListItem[]) => void;
  fetchServers: () => Promise<void>;
  /** Cascade refetch is done by the caller (AppLayout) to avoid circular deps. */
  setActiveServer: (serverId: string) => void;
  fetchActiveServer: () => Promise<void>;
  createServer: (req: CreateServerRequest) => Promise<Server | null>;
  joinServer: (inviteCode: string) => Promise<Server | null>;
  leaveServer: (serverId: string) => Promise<boolean>;
  deleteServer: (serverId: string) => Promise<boolean>;
  reorderServers: (items: { id: string; position: number }[]) => Promise<boolean>;

  // ─── WS Event Handlers ───

  handleServerUpdate: (server: Server) => void;
  handleServerCreate: (server: ServerListItem) => void;
  handleServerDelete: (serverId: string) => void;

  // ─── Mute Actions ───

  setMutedServersFromReady: (ids: string[]) => void;
  muteServer: (serverId: string, duration: string) => Promise<boolean>;
  unmuteServer: (serverId: string) => Promise<boolean>;
  isServerMuted: (serverId: string) => boolean;

  // ─── E2EE Toggle ───

  /** Toggle server E2EE (owner only) */
  toggleE2EE: (serverId: string, enabled: boolean) => Promise<boolean>;
};

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: localStorage.getItem(LAST_SERVER_KEY),
  activeServer: null,
  isLoading: false,
  mutedServerIds: new Set<string>(),

  setServersFromReady: (servers) => {
    set({ servers });
    // If no active server or active not in list, select first
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
    // Clear server-scoped stores immediately to prevent stale data flash
    // (useEffect runs after render, but we need the clear before).
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
      // Add to list + set active (atomic). WS event will also come but we add here against race.
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
      // Add to list + set active (WS event will also come)
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
      // WS event will also come
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
      // WS event will also come
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

  reorderServers: async (items) => {
    // Save for rollback
    const prevServers = get().servers;

    // Optimistic update: sort by new positions
    const positionMap = new Map(items.map((item) => [item.id, item.position]));
    const sorted = [...prevServers].sort((a, b) => {
      const posA = positionMap.get(a.id) ?? 9999;
      const posB = positionMap.get(b.id) ?? 9999;
      return posA - posB;
    });
    set({ servers: sorted });

    const res = await serversApi.reorderServers(items);
    if (!res.success) {
      // Rollback
      set({ servers: prevServers });
      return false;
    }

    return true;
  },

  // ─── WS Event Handlers ───

  handleServerUpdate: (server) => {
    set((state) => {
      // Update sidebar list entry
      const servers = state.servers.map((s) =>
        s.id === server.id
          ? { id: server.id, name: server.name, icon_url: server.icon_url }
          : s
      );
      // Update active server detail if applicable
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

  // ─── Mute Actions ───

  setMutedServersFromReady: (ids) => {
    set({ mutedServerIds: new Set(ids) });
  },

  muteServer: async (serverId, duration) => {
    const res = await serversApi.muteServer(serverId, duration);
    if (res.success) {
      set((state) => {
        const next = new Set(state.mutedServerIds);
        next.add(serverId);
        return { mutedServerIds: next };
      });
      return true;
    }
    return false;
  },

  unmuteServer: async (serverId) => {
    const res = await serversApi.unmuteServer(serverId);
    if (res.success) {
      set((state) => {
        const next = new Set(state.mutedServerIds);
        next.delete(serverId);
        return { mutedServerIds: next };
      });
      return true;
    }
    return false;
  },

  isServerMuted: (serverId) => {
    return get().mutedServerIds.has(serverId);
  },

  toggleE2EE: async (serverId, enabled) => {
    const res = await serversApi.updateServer(serverId, { e2ee_enabled: enabled });
    // server_update WS event will trigger handleServerUpdate automatically
    if (res.success && enabled) {
      useE2EEStore.getState().checkAndPromptRecovery();
    }
    return res.success;
  },
}));
