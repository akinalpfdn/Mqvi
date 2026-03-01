/**
 * Member Store — Zustand ile üye + presence state yönetimi.
 *
 * Bu store üyeleri ve online durumlarını yönetir:
 * - Backend'den tüm üyeleri fetch eder
 * - Online kullanıcı ID'lerini Set olarak tutar (hızlı lookup)
 * - WebSocket event'leri ile gerçek zamanlı güncellenir
 *
 * Multi-server: fetchMembers activeServerId'ye göre server-scoped API çağrısı yapar.
 *
 * Online tracking neden Set?
 * Array'de includes() O(n), Set'te has() O(1).
 * Üye listesi sürekli render edildiğinden, her member için
 * "bu kullanıcı online mı?" sorusunun hızlı cevaplanması gerekir.
 */

import { create } from "zustand";
import * as memberApi from "../api/members";
import { useServerStore } from "./serverStore";
import type { MemberWithRoles, UserStatus, Role } from "../types";

type MemberState = {
  /** Tüm üyeler (rolleriyle birlikte) */
  members: MemberWithRoles[];
  /** Online kullanıcı ID'leri — Set olarak tutulur (O(1) lookup) */
  onlineUserIds: Set<string>;
  /** Yüklenme durumu */
  isLoading: boolean;

  // ─── Actions ───
  fetchMembers: () => Promise<void>;

  // ─── WS Event Handlers ───

  /** "ready" event'i — bağlantı kurulduğunda online kullanıcıları set eder */
  handleReady: (onlineUserIds: string[]) => void;

  /** "presence_update" — kullanıcı online/offline/idle/dnd durumu değişti */
  handlePresenceUpdate: (userId: string, status: UserStatus) => void;

  /** "member_join" — yeni üye katıldı */
  handleMemberJoin: (member: MemberWithRoles) => void;

  /** "member_leave" — üye ayrıldı (kick, ban veya kendi isteği) */
  handleMemberLeave: (userId: string) => void;

  /** "member_update" — üye bilgileri güncellendi (rol değişikliği, profil) */
  handleMemberUpdate: (member: MemberWithRoles) => void;

  /** "role_create" — yeni rol oluşturuldu */
  handleRoleCreate: (role: Role) => void;

  /** "role_update" — rol güncellendi (isim, renk, permission) */
  handleRoleUpdate: (role: Role) => void;

  /** "role_delete" — rol silindi */
  handleRoleDelete: (roleId: string) => void;

  /** "roles_reorder" — rol sıralaması güncellendi */
  handleRolesReorder: (roles: Role[]) => void;

  /** Server değiştirildiğinde store'u temizler */
  clearForServerSwitch: () => void;
};

export const useMemberStore = create<MemberState>((set) => ({
  members: [],
  onlineUserIds: new Set<string>(),
  isLoading: false,

  /**
   * fetchMembers — Backend'den aktif sunucunun üyelerini çeker.
   *
   * Multi-server: serverStore'dan activeServerId alır ve
   * GET /api/servers/{serverId}/members çağırır.
   */
  fetchMembers: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    set({ isLoading: true });

    const res = await memberApi.getMembers(serverId);
    if (res.data) {
      // onlineUserIds'ı burada SET ETME — WS ready event'i ve
      // handlePresenceUpdate tek otorite. DB status'u stale olabilir
      // (server restart sonrası "online"/"idle" kalabilir), WS gerçeği bilir.
      set({ members: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  // ─── WS Event Handlers ───

  handleReady: (onlineUserIds) => {
    set({ onlineUserIds: new Set(onlineUserIds) });
    // Ready geldiğinde üyeleri de fetch et — güncel bilgi almak için
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
        // Profile update (BroadcastToAll) roles boş gönderir çünkü
        // server-agnostic — hangi sunucunun rollerini göndereceğini bilmez.
        // Bu durumda mevcut rolleri ve yetkileri koru.
        // Rol değişikliği ise (roles dolu) yeni rolleri kullan.
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
    // roleStore handle eder
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
