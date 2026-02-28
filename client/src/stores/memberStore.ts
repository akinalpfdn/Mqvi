/**
 * Member Store — Zustand ile üye + presence state yönetimi.
 *
 * Bu store üyeleri ve online durumlarını yönetir:
 * - Backend'den tüm üyeleri fetch eder
 * - Online kullanıcı ID'lerini Set olarak tutar (hızlı lookup)
 * - WebSocket event'leri ile gerçek zamanlı güncellenir
 *
 * Online tracking neden Set?
 * Array'de includes() O(n), Set'te has() O(1).
 * Üye listesi sürekli render edildiğinden, her member için
 * "bu kullanıcı online mı?" sorusunun hızlı cevaplanması gerekir.
 *
 * WS Event → Store entegrasyonu:
 * useWebSocket hook'u gelen event'e göre bu store'un handler'larını çağırır.
 * Handler'lar immutable update yapar (Zustand → React rerender tetikler).
 */

import { create } from "zustand";
import * as memberApi from "../api/members";
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
};

export const useMemberStore = create<MemberState>((set) => ({
  members: [],
  onlineUserIds: new Set<string>(),
  isLoading: false,

  /**
   * fetchMembers — Backend'den tüm üyeleri çeker.
   * "ready" event'i geldiğinde ve component mount olduğunda çağrılır.
   */
  fetchMembers: async () => {
    set({ isLoading: true });

    const res = await memberApi.getMembers();
    if (res.data) {
      // API'den gelen member.status bilgisine göre onlineUserIds Set'ini yeniden oluştur.
      // Ready event'ten gelen Set eksik olabilir (race condition) — API veritabanından
      // güncel status bilgisini döner, bu yüzden en güvenilir kaynaktır.
      const freshOnlineIds = new Set<string>(
        res.data
          .filter((m) => m.status !== "offline")
          .map((m) => m.id),
      );
      set({ members: res.data, onlineUserIds: freshOnlineIds, isLoading: false });
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
      // Online set'i güncelle
      const newSet = new Set(state.onlineUserIds);
      if (status === "offline") {
        newSet.delete(userId);
      } else {
        newSet.add(userId);
      }

      // Members dizisindeki status'u da güncelle
      const members = state.members.map((m) =>
        m.id === userId ? { ...m, status } : m
      );

      return { onlineUserIds: newSet, members };
    });
  },

  handleMemberJoin: (member) => {
    set((state) => {
      // Duplicate kontrolü
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

  handleMemberUpdate: (member) => {
    set((state) => ({
      members: state.members.map((m) =>
        m.id === member.id ? member : m
      ),
    }));
  },

  handleRoleCreate: (_role) => {
    // Yeni rol oluşturulduğunda üye listesini yenilemek gerekmez —
    // roller üyelerin roles[] dizisinde taşınır.
    // Bu event roleStore tarafından handle edilir (Faz 3G).
    // Burada sadece placeholder, ileride roleStore'a aktarılacak.
  },

  handleRoleUpdate: (role) => {
    // Bir rol güncellendiğinde, o role sahip tüm üyelerin görünümü değişir
    // (renk, isim, permission). Members dizisindeki role referanslarını güncelle
    // ve effective_permissions'ı yeniden hesapla.
    //
    // effective_permissions = tüm rollerin permissions'ının bitwise OR'u.
    // Backend'deki ToMemberWithRoles ile aynı algoritma — frontend'de de
    // hesaplanması gerekir ki role_update geldiğinde permission-gated UI
    // (MessageInput, VoiceService, MemberItem) anında güncellensin.
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
    // Silinen rolü tüm üyelerden çıkar ve effective_permissions'ı yeniden hesapla.
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
    // Rol sıralaması değiştiğinde, üyelerin roles[] dizisindeki rolleri güncelle.
    // Position değişir ama permissions değişmez → effective_permissions aynı kalır.
    const roleMap = new Map(roles.map((r) => [r.id, r]));
    set((state) => ({
      members: state.members.map((m) => ({
        ...m,
        roles: m.roles.map((r) => roleMap.get(r.id) ?? r),
      })),
    }));
  },
}));
