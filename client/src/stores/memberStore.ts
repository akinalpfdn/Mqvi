/**
 * Member Store — Member list + presence state management.
 * Online user IDs stored as Set for O(1) lookup.
 */

import { create } from "zustand";
import * as memberApi from "../api/members";
import { useServerStore } from "./serverStore";
import type { MemberWithRoles, UserStatus, Role } from "../types";

type MemberState = {
  members: MemberWithRoles[];
  onlineUserIds: Set<string>;
  isLoading: boolean;

  // ─── Actions ───
  fetchMembers: () => Promise<void>;

  // ─── WS Event Handlers ───
  handleReady: (onlineUserIds: string[]) => void;
  handlePresenceUpdate: (userId: string, status: UserStatus) => void;
  handleMemberJoin: (member: MemberWithRoles) => void;
  handleMemberLeave: (userId: string) => void;
  handleMemberUpdate: (member: MemberWithRoles) => void;
  handleRoleCreate: (role: Role) => void;
  handleRoleUpdate: (role: Role) => void;
  handleRoleDelete: (roleId: string) => void;
  handleRolesReorder: (roles: Role[]) => void;
  clearForServerSwitch: () => void;
};

export const useMemberStore = create<MemberState>((set) => ({
  members: [],
  onlineUserIds: new Set<string>(),
  isLoading: false,

  /**
   * Stale request guard: if activeServerId changed while the request was in flight,
   * discard the response to prevent cross-server data contamination.
   */
  fetchMembers: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    set({ isLoading: true });

    const res = await memberApi.getMembers(serverId);

    const currentServerId = useServerStore.getState().activeServerId;
    if (currentServerId !== serverId) return;

    if (res.data) {
      // Merge member statuses into onlineUserIds to fix race conditions
      // where fetchMembers returns after presence events have been missed.
      set((state) => {
        const merged = new Set(state.onlineUserIds);
        for (const m of res.data!) {
          if (m.status && m.status !== "offline") {
            merged.add(m.id);
          }
        }
        return { members: res.data!, onlineUserIds: merged, isLoading: false };
      });
    } else {
      set({ isLoading: false });
    }
  },

  // ─── WS Event Handlers ───

  handleReady: (onlineUserIds) => {
    set({ onlineUserIds: new Set(onlineUserIds) });
    useMemberStore.getState().fetchMembers();
  },

  handlePresenceUpdate: (userId, status) => {
    set((state) => {
      const newSet = new Set(state.onlineUserIds);
      if (status === "offline") {
        newSet.delete(userId);
      } else {
        newSet.add(userId);
      }

      const members = state.members.map((m) =>
        m.id === userId ? { ...m, status } : m
      );

      return { onlineUserIds: newSet, members };
    });
  },

  handleMemberJoin: (member) => {
    set((state) => {
      if (state.members.some((m) => m.id === member.id)) return state;
      return { members: [...state.members, member] };
    });
  },

  handleMemberLeave: (userId) => {
    set((state) => {
      const newSet = new Set(state.onlineUserIds);
      newSet.delete(userId);
      return {
        members: state.members.filter((m) => m.id !== userId),
        onlineUserIds: newSet,
      };
    });
  },

  handleMemberUpdate: (updated) => {
    set((state) => ({
      members: state.members.map((m) => {
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
    }));
  },

  handleRoleCreate: (_role) => {
    // Handled by roleStore
  },

  handleRoleUpdate: (role) => {
    set((state) => ({
      members: state.members.map((m) => {
        const updatedRoles = m.roles.map((r) => (r.id === role.id ? role : r));
        const effectivePerms = updatedRoles.reduce(
          (acc, r) => acc | r.permissions,
          0
        );
        return { ...m, roles: updatedRoles, effective_permissions: effectivePerms };
      }),
    }));
  },

  handleRoleDelete: (roleId) => {
    set((state) => ({
      members: state.members.map((m) => {
        const filteredRoles = m.roles.filter((r) => r.id !== roleId);
        const effectivePerms = filteredRoles.reduce(
          (acc, r) => acc | r.permissions,
          0
        );
        return { ...m, roles: filteredRoles, effective_permissions: effectivePerms };
      }),
    }));
  },

  handleRolesReorder: (roles) => {
    const roleMap = new Map(roles.map((r) => [r.id, r]));
    set((state) => ({
      members: state.members.map((m) => ({
        ...m,
        roles: m.roles.map((r) => roleMap.get(r.id) ?? r),
      })),
    }));
  },

  clearForServerSwitch: () => {
    set({ members: [], isLoading: false });
  },
}));
