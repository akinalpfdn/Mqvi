/**
 * Role Store — Zustand ile rol yönetimi state'i.
 *
 * Bu store Settings panelindeki rol yönetimi için kullanılır:
 * - Tüm rolleri fetch ve cache
 * - Seçili rol tracking
 * - CRUD operasyonları (API çağrısı + WS ile senkron)
 *
 * memberStore'daki role_create/update/delete handler'ları
 * üye listesindeki rolleri günceller.
 * Bu store ise Settings panelindeki rol listesini yönetir.
 */

import { create } from "zustand";
import * as roleApi from "../api/roles";
import type { Role } from "../types";

type RoleState = {
  /** Tüm roller (position DESC sıralı) */
  roles: Role[];
  /** Seçili rol ID'si (settings panelinde düzenlenmekte olan) */
  selectedRoleId: string | null;
  /** Yüklenme durumu */
  isLoading: boolean;

  // ─── Actions ───
  fetchRoles: () => Promise<void>;
  selectRole: (roleId: string) => void;
  createRole: (data: {
    name: string;
    color: string;
    permissions: number;
  }) => Promise<void>;
  updateRole: (
    id: string,
    data: { name?: string; color?: string; permissions?: number }
  ) => Promise<void>;
  deleteRole: (id: string) => Promise<void>;

  // ─── WS Event Handlers ───
  handleRoleCreate: (role: Role) => void;
  handleRoleUpdate: (role: Role) => void;
  handleRoleDelete: (roleId: string) => void;
};

export const useRoleStore = create<RoleState>((set, get) => ({
  roles: [],
  selectedRoleId: null,
  isLoading: false,

  fetchRoles: async () => {
    set({ isLoading: true });
    const res = await roleApi.getRoles();
    if (res.data) {
      // Position DESC sırala
      const sorted = [...res.data].sort((a, b) => b.position - a.position);
      set({ roles: sorted, isLoading: false });

      // İlk yüklemede: seçili rol yoksa ilk rolü seç
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
    const res = await roleApi.createRole(data);
    if (res.data) {
      // WS event de gelecek ama hemen UI'da göstermek için ekliyoruz
      set((state) => ({
        roles: [res.data!, ...state.roles].sort(
          (a, b) => b.position - a.position
        ),
        selectedRoleId: res.data!.id,
      }));
    }
  },

  updateRole: async (id, data) => {
    const res = await roleApi.updateRole(id, data);
    if (res.data) {
      set((state) => ({
        roles: state.roles.map((r) => (r.id === id ? res.data! : r)),
      }));
    }
  },

  deleteRole: async (id) => {
    const res = await roleApi.deleteRole(id);
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
    }
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
}));
