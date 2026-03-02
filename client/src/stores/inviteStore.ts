/**
 * Invite Store — Zustand ile davet kodu state yönetimi.
 *
 * Neden ayrı store?
 * Slice pattern: her concern ayrı dosyada.
 * Invite verisi sadece Settings modal'ın Invites tab'ında kullanılır.
 *
 * Zustand selector stable ref notu:
 * invites listesi başlangıçta boş dizi olarak tanımlanır (EMPTY_INVITES),
 * böylece component'lerde `?? []` kullanımına gerek kalmaz.
 */

import { create } from "zustand";
import * as inviteApi from "../api/invites";
import { useServerStore } from "./serverStore";
import type { Invite } from "../types";

/** Stable empty array referansı — infinite re-render önlemi */
const EMPTY_INVITES: Invite[] = [];

type InviteState = {
  /** Davet kodu listesi */
  invites: Invite[];
  /** Yüklenme durumu */
  isLoading: boolean;

  /** Tüm davet kodlarını sunucudan çek */
  fetchInvites: () => Promise<void>;

  /** Yeni davet kodu oluştur, listeye ekle */
  createInvite: (maxUses: number, expiresIn: number) => Promise<Invite | null>;

  /**
   * Mevcut sınırsız/süresiz (permanent) invite'ı getir, yoksa oluştur.
   * "Copy Invite Link" ve "Send Invites" gibi akışlarda kullanılır —
   * her tıklamada yeni kod oluşturmak yerine var olanı yeniden kullanır.
   */
  getOrCreatePermanentInvite: () => Promise<Invite | null>;

  /** Davet kodunu sil, listeden çıkar */
  deleteInvite: (code: string) => Promise<boolean>;
};

export const useInviteStore = create<InviteState>((set, get) => ({
  invites: EMPTY_INVITES,
  isLoading: false,

  fetchInvites: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    set({ isLoading: true });

    const res = await inviteApi.getInvites(serverId);
    if (res.success && res.data) {
      set({ invites: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  createInvite: async (maxUses, expiresIn) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return null;
    const res = await inviteApi.createInvite(serverId, {
      max_uses: maxUses,
      expires_in: expiresIn,
    });

    if (res.success && res.data) {
      // Listeyi yeniden çek — creator bilgisi için full refetch
      // (create endpoint sadece Invite döner, InviteWithCreator değil)
      await get().fetchInvites();
      return res.data;
    }

    return null;
  },

  getOrCreatePermanentInvite: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return null;

    // Store'da invite yoksa sunucudan çek
    if (get().invites.length === 0) {
      await get().fetchInvites();
    }

    // Mevcut permanent invite'ı bul (max_uses=0, expires_at=null, henüz süresi dolmamış)
    const existing = get().invites.find(
      (inv) => inv.max_uses === 0 && inv.expires_at === null,
    );
    if (existing) return existing;

    // Yoksa yeni oluştur
    return get().createInvite(0, 0);
  },

  deleteInvite: async (code) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const res = await inviteApi.deleteInvite(serverId, code);

    if (res.success) {
      // Optimistic update: listeden hemen çıkar
      set((state) => ({
        invites: state.invites.filter((inv) => inv.code !== code),
      }));
      return true;
    }

    return false;
  },
}));
