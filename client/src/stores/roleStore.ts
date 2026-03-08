/**
 * Role Store — Role management state for settings panel.
 *
 * Multi-server: all actions use activeServerId from serverStore.
 */

import { create } from "zustand";
import * as roleApi from "../api/roles";
import { useServerStore } from "./serverStore";
import type { Role } from "../types";

type RoleState = {
  /** All roles (sorted by position DESC) */
  roles: Role[];
  /** Currently selected role ID (being edited in settings) */
  selectedRoleId: string | null;
  isLoading: boolean;

  // ─── Actions ───
  fetchRoles: () => Promise<void>;
  selectRole: (roleId: string) => void;
  createRole: (data: {
    name: string;
    color: string;
    permissions: number;
  }) => Promise<boolean>;
  updateRole: (
    id: string,
    data: { name?: string; color?: string; permissions?: number }
  ) => Promise<boolean>;
  deleteRole: (id: string) => Promise<boolean>;
  reorderRoles: (items: { id: string; position: number }[]) => Promise<boolean>;

  // ─── WS Event Handlers ───
  handleRoleCreate: (role: Role) => void;
  handleRoleUpdate: (role: Role) => void;
  handleRoleDelete: (roleId: string) => void;
  handleRolesReorder: (roles: Role[]) => void;

  clearForServerSwitch: () => void;
};

export const useRoleStore = create<RoleState>((set, get) => ({
  roles: [],
  selectedRoleId: null,
  isLoading: false,

  fetchRoles: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    set({ isLoading: true });
    const res = await roleApi.getRoles(serverId);
    if (res.data) {
      const sorted = [...res.data].sort((a, b) => b.position - a.position);
      set({ roles: sorted, isLoading: false });

      if (!get().selectedRoleId && sorted.length > 0) {
        set({ selectedRoleId: sorted[0].id });
      }
    } else {
      set({ isLoading: false });
    }
  },

  selectRole: (roleId) => {
    set({ selectedRoleId: roleId });
  },

  createRole: async (data) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await roleApi.createRole(serverId, data);
    if (res.data) {
      const newRole = res.data;
      set((state) => {
        if (state.roles.some((r) => r.id === newRole.id)) {
          return { selectedRoleId: newRole.id };
        }
        return {
          roles: [newRole, ...state.roles].sort(
            (a, b) => b.position - a.position
          ),
          selectedRoleId: newRole.id,
        };
      });
      return true;
    }
    return false;
  },

  updateRole: async (id, data) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await roleApi.updateRole(serverId, id, data);
    if (res.data) {
      set((state) => ({
        roles: state.roles.map((r) => (r.id === id ? res.data! : r)),
      }));
      return true;
    }
    return false;
  },

  deleteRole: async (id) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const res = await roleApi.deleteRole(serverId, id);
    if (res.data) {
      set((state) => {
        const roles = state.roles.filter((r) => r.id !== id);
        return {
          roles,
          selectedRoleId:
            state.selectedRoleId === id
              ? roles[0]?.id ?? null
              : state.selectedRoleId,
        };
      });
      return true;
    }
    return false;
  },

  reorderRoles: async (items) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    const prevRoles = get().roles;

    const positionMap = new Map(items.map((item) => [item.id, item.position]));
    set((state) => ({
      roles: state.roles
        .map((r) => {
          const newPos = positionMap.get(r.id);
          return newPos !== undefined ? { ...r, position: newPos } : r;
        })
        .sort((a, b) => b.position - a.position),
    }));

    const res = await roleApi.reorderRoles(serverId, items);
    if (!res.success) {
      set({ roles: prevRoles });
      return false;
    }

    return true;
  },

  // ─── WS Event Handlers ───

  handleRoleCreate: (role) => {
    set((state) => {
      if (state.roles.some((r) => r.id === role.id)) return state;
      return {
        roles: [...state.roles, role].sort(
          (a, b) => b.position - a.position
        ),
      };
    });
  },

  handleRoleUpdate: (role) => {
    set((state) => ({
      roles: state.roles.map((r) => (r.id === role.id ? role : r)),
    }));
  },

  handleRoleDelete: (roleId) => {
    set((state) => {
      const roles = state.roles.filter((r) => r.id !== roleId);
      return {
        roles,
        selectedRoleId:
          state.selectedRoleId === roleId
            ? roles[0]?.id ?? null
            : state.selectedRoleId,
      };
    });
  },

  handleRolesReorder: (roles) => {
    const sorted = [...roles].sort((a, b) => b.position - a.position);
    set({ roles: sorted });
  },

  clearForServerSwitch: () => {
    set({ roles: [], selectedRoleId: null, isLoading: false });
  },
}));
