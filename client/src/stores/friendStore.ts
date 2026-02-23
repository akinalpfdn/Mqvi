/**
 * Friend Store — Arkadaşlık sistemi state yönetimi.
 *
 * Tasarım kararları:
 * - friends: FriendshipWithUser[] — kabul edilmiş arkadaşlar
 * - incoming/outgoing: Bekleyen arkadaşlık istekleri (gelen/giden)
 * - WS event'leri ile gerçek zamanlı güncelleme
 *
 * Zustand selector stable ref notu:
 * EMPTY_* module-level sabit olarak tanımlanır.
 * Selector'larda `?? []` kullanmak her render'da yeni referans oluşturur
 * ve sonsuz re-render'a neden olur.
 */

import { create } from "zustand";
import * as friendsApi from "../api/friends";
import type { FriendshipWithUser } from "../types";

const EMPTY_FRIENDS: FriendshipWithUser[] = [];
const EMPTY_INCOMING: FriendshipWithUser[] = [];
const EMPTY_OUTGOING: FriendshipWithUser[] = [];

type FriendState = {
  /** Kabul edilmiş arkadaşlar */
  friends: FriendshipWithUser[];
  /** Gelen bekleyen istekler */
  incoming: FriendshipWithUser[];
  /** Gönderilen bekleyen istekler */
  outgoing: FriendshipWithUser[];
  /** Yüklenme durumu */
  isLoading: boolean;

  // ─── Actions ───

  /** Arkadaş listesini backend'den çek */
  fetchFriends: () => Promise<void>;
  /** İstek listelerini (incoming + outgoing) backend'den çek */
  fetchRequests: () => Promise<void>;
  /** Username ile arkadaşlık isteği gönder */
  sendRequest: (username: string) => Promise<{ success: boolean; error?: string }>;
  /** Gelen isteği kabul et */
  acceptRequest: (requestId: string) => Promise<boolean>;
  /** Gelen isteği reddet veya gönderilen isteği iptal et */
  declineRequest: (requestId: string) => Promise<boolean>;
  /** Arkadaşlıktan çıkar */
  removeFriend: (userId: string) => Promise<boolean>;

  // ─── WS Event Handlers ───

  /** Yeni arkadaşlık isteği geldi (friend_request_create) */
  handleFriendRequestCreate: (data: FriendshipWithUser) => void;
  /** Arkadaşlık isteği kabul edildi (friend_request_accept) */
  handleFriendRequestAccept: (data: FriendshipWithUser) => void;
  /** Arkadaşlık isteği reddedildi/iptal edildi (friend_request_decline) */
  handleFriendRequestDecline: (data: { id: string; user_id: string }) => void;
  /** Arkadaşlıktan çıkarıldı (friend_remove) */
  handleFriendRemove: (data: { user_id: string }) => void;
};

export const useFriendStore = create<FriendState>((set, get) => ({
  friends: EMPTY_FRIENDS,
  incoming: EMPTY_INCOMING,
  outgoing: EMPTY_OUTGOING,
  isLoading: false,

  // ─── Actions ───

  fetchFriends: async () => {
    set({ isLoading: true });
    try {
      const res = await friendsApi.listFriends();
      if (res.success && res.data) {
        set({ friends: res.data });
      }
    } finally {
      set({ isLoading: false });
    }
  },

  fetchRequests: async () => {
    try {
      const res = await friendsApi.listRequests();
      if (res.success && res.data) {
        set({
          incoming: res.data.incoming,
          outgoing: res.data.outgoing,
        });
      }
    } catch {
      // Sessiz hata — kullanıcıya toast göstermek handler'ın işi
    }
  },

  sendRequest: async (username: string) => {
    const res = await friendsApi.sendRequest(username);
    if (res.success && res.data) {
      // Giden istekler listesine ekle (veya accepted ise friends'e)
      if (res.data.status === "accepted") {
        set((s) => ({ friends: [res.data!, ...s.friends] }));
      } else {
        set((s) => ({ outgoing: [res.data!, ...s.outgoing] }));
      }
      return { success: true };
    }
    return { success: false, error: res.error };
  },

  acceptRequest: async (requestId: string) => {
    const res = await friendsApi.acceptRequest(requestId);
    if (res.success && res.data) {
      set((s) => ({
        // Gelen isteklerden kaldır
        incoming: s.incoming.filter((r) => r.id !== requestId),
        // Arkadaş listesine ekle
        friends: [res.data!, ...s.friends],
      }));
      return true;
    }
    return false;
  },

  declineRequest: async (requestId: string) => {
    const res = await friendsApi.declineRequest(requestId);
    if (res.success) {
      set((s) => ({
        // Hem incoming hem outgoing'den kaldır (kullanıcı her iki tarafta olabilir)
        incoming: s.incoming.filter((r) => r.id !== requestId),
        outgoing: s.outgoing.filter((r) => r.id !== requestId),
      }));
      return true;
    }
    return false;
  },

  removeFriend: async (userId: string) => {
    const res = await friendsApi.removeFriend(userId);
    if (res.success) {
      set((s) => ({
        friends: s.friends.filter((f) => f.user_id !== userId),
      }));
      return true;
    }
    return false;
  },

  // ─── WS Event Handlers ───

  handleFriendRequestCreate: (data: FriendshipWithUser) => {
    // Yeni gelen istek — incoming listesine ekle
    set((s) => ({
      incoming: [data, ...s.incoming],
    }));
  },

  handleFriendRequestAccept: (data: FriendshipWithUser) => {
    // İsteğimiz kabul edildi — outgoing'den kaldır, friends'e ekle
    const { outgoing } = get();
    set({
      outgoing: outgoing.filter((r) => r.id !== data.id),
      friends: [data, ...get().friends],
    });
  },

  handleFriendRequestDecline: (data: { id: string; user_id: string }) => {
    // İstek reddedildi — hem incoming hem outgoing'den kaldır
    set((s) => ({
      incoming: s.incoming.filter((r) => r.id !== data.id),
      outgoing: s.outgoing.filter((r) => r.id !== data.id),
    }));
  },

  handleFriendRemove: (data: { user_id: string }) => {
    // Arkadaşlıktan çıkarıldı — friends listesinden kaldır
    set((s) => ({
      friends: s.friends.filter((f) => f.user_id !== data.user_id),
    }));
  },
}));
