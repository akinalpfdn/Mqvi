/**
 * Member Store — Per-server member list + presence state management.
 * Members are cached per server: `membersByServer[serverId] -> MemberWithRoles[]`.
 * Online user IDs are global (presence is cross-server).
 */

import { create } from "zustand";
import * as memberApi from "../api/members";
import { useServerStore } from "./serverStore";
import type { MemberWithRoles, UserStatus, Role } from "../types";

type MemberState = {
  membersByServer: Record<string, MemberWithRoles[]>;
  onlineUserIds: Set<string>;
  loadingServers: Set<string>;

  // ─── Selectors ───
  /** Get members for a specific server (returns stable empty array if not loaded) */
  getMembersForServer: (serverId: string) => MemberWithRoles[];
  isLoading: boolean;

  // ─── Actions ───
  fetchMembers: (serverId?: string) => Promise<void>;

  // ─── WS Event Handlers (all require serverId) ───
  handleReady: (onlineUserIds: string[]) => void;
  handlePresenceUpdate: (userId: string, status: UserStatus) => void;
  handleMemberJoin: (serverId: string, member: MemberWithRoles) => void;
  handleMemberLeave: (serverId: string, userId: string) => void;
  handleMemberUpdate: (serverId: string, member: MemberWithRoles) => void;
  handleRoleCreate: (serverId: string, role: Role) => void;
  handleRoleUpdate: (serverId: string, role: Role) => void;
  handleRoleDelete: (serverId: string, roleId: string) => void;
  handleRolesReorder: (serverId: string, roles: Role[]) => void;
  /** Remove cache for a specific server (e.g. on leave/delete) */
  clearServer: (serverId: string) => void;
};

/** Stable empty ref for selectors */
const EMPTY_MEMBERS: MemberWithRoles[] = [];

/** Tracks in-flight fetches to prevent duplicate requests */
const fetchingServers = new Set<string>();

export const useMemberStore = create<MemberState>((set, get) => ({
  membersByServer: {},
  onlineUserIds: new Set<string>(),
  loadingServers: new Set(),

  // ─── Selectors ───

  isLoading: false,

  getMembersForServer: (serverId) => {
    return get().membersByServer[serverId] ?? EMPTY_MEMBERS;
  },

  fetchMembers: async (explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;
    if (fetchingServers.has(serverId)) return;

    fetchingServers.add(serverId);
    set((state) => ({
      loadingServers: new Set([...state.loadingServers, serverId]),
    }));

    const res = await memberApi.getMembers(serverId);

    fetchingServers.delete(serverId);

    if (res.data) {
      set((state) => {
        // Merge member statuses into onlineUserIds
        const merged = new Set(state.onlineUserIds);
        for (const m of res.data!) {
          if (m.status && m.status !== "offline") {
            merged.add(m.id);
          }
        }
        const newLoading = new Set(state.loadingServers);
        newLoading.delete(serverId);
        return {
          membersByServer: { ...state.membersByServer, [serverId]: res.data! },
          onlineUserIds: merged,
          loadingServers: newLoading,
        };
      });
    } else {
      set((state) => {
        const newLoading = new Set(state.loadingServers);
        newLoading.delete(serverId);
        return { loadingServers: newLoading };
      });
    }
  },

  // ─── WS Event Handlers ───

  handleReady: (onlineUserIds) => {
    set({ onlineUserIds: new Set(onlineUserIds) });
    // Fetch members for active server on ready
    const serverId = useServerStore.getState().activeServerId;
    if (serverId) useMemberStore.getState().fetchMembers(serverId);
  },

  handlePresenceUpdate: (userId, status) => {
    set((state) => {
      const newOnline = new Set(state.onlineUserIds);
      if (status === "offline") {
        newOnline.delete(userId);
      } else {
        newOnline.add(userId);
      }

      // Update status across all cached servers
      const updated: Record<string, MemberWithRoles[]> = {};
      let changed = false;
      for (const [sid, members] of Object.entries(state.membersByServer)) {
        const idx = members.findIndex((m) => m.id === userId);
        if (idx >= 0) {
          changed = true;
          updated[sid] = members.map((m) =>
            m.id === userId ? { ...m, status } : m
          );
        }
      }

      return {
        onlineUserIds: newOnline,
        membersByServer: changed
          ? { ...state.membersByServer, ...updated }
          : state.membersByServer,
      };
    });
  },

  handleMemberJoin: (serverId, member) => {
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      if (current.some((m) => m.id === member.id)) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: [...current, member],
        },
      };
    });
  },

  handleMemberLeave: (serverId, userId) => {
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      const newOnline = new Set(state.onlineUserIds);
      newOnline.delete(userId);
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.filter((m) => m.id !== userId),
        },
        onlineUserIds: newOnline,
      };
    });
  },

  handleMemberUpdate: (serverId, updated) => {
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.map((m) => {
            if (m.id !== updated.id) return m;
            // Profile update (BroadcastToAll) sends empty roles since it's server-agnostic.
            // Preserve existing roles/permissions in that case.
            const hasRoles = updated.roles && updated.roles.length > 0;
            return {
              ...m,
              ...updated,
              roles: hasRoles ? updated.roles : m.roles,
              effective_permissions: hasRoles
                ? updated.effective_permissions
                : m.effective_permissions,
            };
          }),
        },
      };
    });
  },

  handleRoleCreate: (_serverId, _role) => {
    // Handled by roleStore — member role assignment comes via member_update
  },

  handleRoleUpdate: (serverId, role) => {
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.map((m) => {
            const updatedRoles = m.roles.map((r) => (r.id === role.id ? role : r));
            const effectivePerms = updatedRoles.reduce(
              (acc, r) => acc | r.permissions,
              0
            );
            return { ...m, roles: updatedRoles, effective_permissions: effectivePerms };
          }),
        },
      };
    });
  },

  handleRoleDelete: (serverId, roleId) => {
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.map((m) => {
            const filteredRoles = m.roles.filter((r) => r.id !== roleId);
            const effectivePerms = filteredRoles.reduce(
              (acc, r) => acc | r.permissions,
              0
            );
            return { ...m, roles: filteredRoles, effective_permissions: effectivePerms };
          }),
        },
      };
    });
  },

  handleRolesReorder: (serverId, roles) => {
    const roleMap = new Map(roles.map((r) => [r.id, r]));
    set((state) => {
      const current = state.membersByServer[serverId];
      if (!current) return state;
      return {
        membersByServer: {
          ...state.membersByServer,
          [serverId]: current.map((m) => ({
            ...m,
            roles: m.roles.map((r) => roleMap.get(r.id) ?? r),
          })),
        },
      };
    });
  },

  clearServer: (serverId) => {
    set((state) => {
      const { [serverId]: _, ...rest } = state.membersByServer;
      return { membersByServer: rest };
    });
  },
}));

/**
 * Derived selector: members for the currently active server.
 * Use this in components that always show active server data.
 */
export function useActiveMembers(): MemberWithRoles[] {
  const serverId = useServerStore((s) => s.activeServerId);
  const membersByServer = useMemberStore((s) => s.membersByServer);
  if (!serverId) return EMPTY_MEMBERS;
  return membersByServer[serverId] ?? EMPTY_MEMBERS;
}

/**
 * Derived selector: members for a specific server (falls back to active).
 * Use this in components that may show cross-server data (e.g. tabs).
 */
export function useMembersForServer(serverId?: string): MemberWithRoles[] {
  const activeServerId = useServerStore((s) => s.activeServerId);
  const membersByServer = useMemberStore((s) => s.membersByServer);
  const id = serverId ?? activeServerId;
  if (!id) return EMPTY_MEMBERS;
  return membersByServer[id] ?? EMPTY_MEMBERS;
}
