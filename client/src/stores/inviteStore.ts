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

  /** Davet kodunu sil, listeden çıkar */
  deleteInvite: (code: string) => Promise<boolean>;
};

export const useInviteStore = create<InviteState>((set, get) => ({
  invites: EMPTY_INVITES,
  isLoading: false,

  fetchInvites: async () => {
    set({ isLoading: true });

    const res = await inviteApi.getInvites();
    if (res.success && res.data) {
      set({ invites: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  createInvite: async (maxUses, expiresIn) => {
    const res = await inviteApi.createInvite({
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

  deleteInvite: async (code) => {
    const res = await inviteApi.deleteInvite(code);

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
