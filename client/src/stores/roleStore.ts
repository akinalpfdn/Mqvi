/**
 * Role Store — Per-server role management.
 * Roles are cached per server: `rolesByServer[serverId] -> Role[]`.
 */

import { create } from "zustand";
import * as roleApi from "../api/roles";
import { useServerStore } from "./serverStore";
import type { Role } from "../types";

type RoleState = {
  rolesByServer: Record<string, Role[]>;
  /** Currently selected role ID (being edited in settings) */
  selectedRoleId: string | null;
  loadingServers: Set<string>;

  // ─── Selectors ───
  getRolesForServer: (serverId: string) => Role[];
  isLoading: boolean;

  // ─── Actions ───
  fetchRoles: (serverId?: string) => Promise<void>;
  selectRole: (roleId: string) => void;
  createRole: (data: {
    name: string;
    color: string;
    permissions: number;
  }) => Promise<boolean>;
  updateRole: (
    id: string,
    data: { name?: string; color?: string; permissions?: number; mentionable?: boolean }
  ) => Promise<boolean>;
  deleteRole: (id: string) => Promise<boolean>;
  reorderRoles: (items: { id: string; position: number }[]) => Promise<boolean>;

  // ─── WS Event Handlers (all require serverId) ───
  handleRoleCreate: (serverId: string, role: Role) => void;
  handleRoleUpdate: (serverId: string, role: Role) => void;
  handleRoleDelete: (serverId: string, roleId: string) => void;
  handleRolesReorder: (serverId: string, roles: Role[]) => void;

  /** Remove cache for a specific server */
  clearServer: (serverId: string) => void;
};

/** Stable empty ref */
const EMPTY_ROLES: Role[] = [];

/** Tracks in-flight fetches */
const fetchingServers = new Set<string>();

export const useRoleStore = create<RoleState>((set, get) => ({
  rolesByServer: {},
  selectedRoleId: null,
  loadingServers: new Set(),

  // ─── Selectors ───

  isLoading: false,

  getRolesForServer: (serverId) => {
    return get().rolesByServer[serverId] ?? EMPTY_ROLES;
  },

  fetchRoles: async (explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;
    if (fetchingServers.has(serverId)) return;

    fetchingServers.add(serverId);
    set((state) => ({
      loadingServers: new Set([...state.loadingServers, serverId]),
    }));

    const res = await roleApi.getRoles(serverId);

    fetchingServers.delete(serverId);

    if (res.data) {
      const sorted = [...res.data].sort((a, b) => b.position - a.position);
      set((state) => {
        const newLoading = new Set(state.loadingServers);
        newLoading.delete(serverId);
        return {
          rolesByServer: { ...state.rolesByServer, [serverId]: sorted },
          loadingServers: newLoading,
        };
      });

      if (!get().selectedRoleId && sorted.length > 0) {
        set({ selectedRoleId: sorted[0].id });
      }
    } else {
      set((state) => {
        const newLoading = new Set(state.loadingServers);
        newLoading.delete(serverId);
        return { loadingServers: newLoading };
      });
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
        const current = state.rolesByServer[serverId] ?? [];
        if (current.some((r) => r.id === newRole.id)) {
          return { selectedRoleId: newRole.id };
        }
        return {
          rolesByServer: {
            ...state.rolesByServer,
            [serverId]: [...current, newRole].sort(
              (a, b) => b.position - a.position
            ),
          },
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
      set((state) => {
        const current = state.rolesByServer[serverId] ?? [];
        return {
          rolesByServer: {
            ...state.rolesByServer,
            [serverId]: current.map((r) => (r.id === id ? res.data! : r)),
          },
        };
      });
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
        const current = state.rolesByServer[serverId] ?? [];
        const roles = current.filter((r) => r.id !== id);
        return {
          rolesByServer: { ...state.rolesByServer, [serverId]: roles },
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

    const prevRoles = get().rolesByServer[serverId] ?? [];

    const positionMap = new Map(items.map((item) => [item.id, item.position]));
    set((state) => {
      const current = state.rolesByServer[serverId] ?? [];
      return {
        rolesByServer: {
          ...state.rolesByServer,
          [serverId]: current
            .map((r) => {
              const newPos = positionMap.get(r.id);
              return newPos !== undefined ? { ...r, position: newPos } : r;
            })
            .sort((a, b) => b.position - a.position),
        },
      };
    });

    const res = await roleApi.reorderRoles(serverId, items);
    if (!res.success) {
      set((state) => ({
        rolesByServer: { ...state.rolesByServer, [serverId]: prevRoles },
      }));
      return false;
    }

    return true;
  },

  // ─── WS Event Handlers ───

  handleRoleCreate: (serverId, role) => {
    set((state) => {
      const current = state.rolesByServer[serverId] ?? [];
      if (current.some((r) => r.id === role.id)) return state;
      return {
        rolesByServer: {
          ...state.rolesByServer,
          [serverId]: [...current, role].sort(
            (a, b) => b.position - a.position
          ),
        },
      };
    });
  },

  handleRoleUpdate: (serverId, role) => {
    set((state) => {
      const current = state.rolesByServer[serverId];
      if (!current) return state;
      return {
        rolesByServer: {
          ...state.rolesByServer,
          [serverId]: current.map((r) => (r.id === role.id ? role : r)),
        },
      };
    });
  },

  handleRoleDelete: (serverId, roleId) => {
    set((state) => {
      const current = state.rolesByServer[serverId];
      if (!current) return state;
      const roles = current.filter((r) => r.id !== roleId);
      return {
        rolesByServer: { ...state.rolesByServer, [serverId]: roles },
        selectedRoleId:
          state.selectedRoleId === roleId
            ? roles[0]?.id ?? null
            : state.selectedRoleId,
      };
    });
  },

  handleRolesReorder: (serverId, roles) => {
    const sorted = [...roles].sort((a, b) => b.position - a.position);
    set((state) => ({
      rolesByServer: { ...state.rolesByServer, [serverId]: sorted },
    }));
  },

  clearServer: (serverId) => {
    set((state) => {
      const { [serverId]: _, ...rest } = state.rolesByServer;
      return { rolesByServer: rest };
    });
  },
}));

/** Stable empty ref */
const EMPTY_ROLES_HOOK: Role[] = [];

/**
 * Derived selector: roles for the currently active server.
 */
export function useActiveRoles(): Role[] {
  const serverId = useServerStore((s) => s.activeServerId);
  const rolesByServer = useRoleStore((s) => s.rolesByServer);
  if (!serverId) return EMPTY_ROLES_HOOK;
  return rolesByServer[serverId] ?? EMPTY_ROLES_HOOK;
}

/**
 * Derived selector: roles for a specific server (falls back to active).
 */
export function useRolesForServer(serverId?: string): Role[] {
  const activeServerId = useServerStore((s) => s.activeServerId);
  const rolesByServer = useRoleStore((s) => s.rolesByServer);
  const id = serverId ?? activeServerId;
  if (!id) return EMPTY_ROLES_HOOK;
  return rolesByServer[id] ?? EMPTY_ROLES_HOOK;
}
