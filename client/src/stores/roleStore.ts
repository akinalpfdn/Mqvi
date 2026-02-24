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
  /** Rol oluştur — başarılıysa true döner (toast feedback için) */
  createRole: (data: {
    name: string;
    color: string;
    permissions: number;
  }) => Promise<boolean>;
  /** Rol güncelle — başarılıysa true döner (toast feedback için) */
  updateRole: (
    id: string,
    data: { name?: string; color?: string; permissions?: number }
  ) => Promise<boolean>;
  /** Rol sil — başarılıysa true döner (toast feedback için) */
  deleteRole: (id: string) => Promise<boolean>;
  /** Rol sıralamasını toplu güncelle — optimistic update + API call */
  reorderRoles: (items: { id: string; position: number }[]) => Promise<boolean>;

  // ─── WS Event Handlers ───
  handleRoleCreate: (role: Role) => void;
  handleRoleUpdate: (role: Role) => void;
  handleRoleDelete: (roleId: string) => void;
  /** WS roles_reorder event handler — store'u tam listeyle replace eder */
  handleRolesReorder: (roles: Role[]) => void;
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
      const newRole = res.data;
      // Duplicate guard: WS role_create event, API response'dan önce gelmiş olabilir.
      // Bu durumda rol zaten state'tedir — tekrar eklememeliyiz.
      set((state) => {
        if (state.roles.some((r) => r.id === newRole.id)) {
          // WS event zaten eklemiş — sadece seçili rolü güncelle
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
    const res = await roleApi.updateRole(id, data);
    if (res.data) {
      set((state) => ({
        roles: state.roles.map((r) => (r.id === id ? res.data! : r)),
      }));
      return true;
    }
    return false;
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
      return true;
    }
    return false;
  },

  reorderRoles: async (items) => {
    const prevRoles = get().roles;

    // Optimistic update — position değerlerini anında uygula
    const positionMap = new Map(items.map((item) => [item.id, item.position]));
    set((state) => ({
      roles: state.roles
        .map((r) => {
          const newPos = positionMap.get(r.id);
          return newPos !== undefined ? { ...r, position: newPos } : r;
        })
        .sort((a, b) => b.position - a.position),
    }));

    const res = await roleApi.reorderRoles(items);
    if (!res.success) {
      // API hatası — eski state'e geri dön
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
}));
