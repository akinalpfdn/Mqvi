/**
 * DM Store — Direct Messages state yönetimi.
 *
 * Tasarım kararları:
 * - channels: DMChannelWithUser[] — tüm DM kanalları (karşı taraf bilgisiyle)
 * - selectedDMId: Seçili DM kanalı ID'si (null = DM görünümünde değil)
 * - messagesByChannel: Record<channelId, DMMessage[]> — DM mesaj cache'i
 * - WS event'leri ile gerçek zamanlı güncelleme
 *
 * Feature parity notu:
 * Channel chat ile aynı özellikleri destekler:
 * - Reply (replyingTo + scrollToMessageId)
 * - Reactions (toggleReaction + handleDMReactionUpdate)
 * - Typing indicator (typingUsers + handleDMTypingStart)
 * - Pin (pinMessage/unpinMessage + handleDMMessagePin/Unpin)
 * - File upload (sendMessage files parametresi)
 * - Search (searchMessages)
 *
 * Zustand selector stable ref notu:
 * EMPTY_CHANNELS ve EMPTY_MESSAGES module-level sabit olarak tanımlanır.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as dmApi from "../api/dm";
import type { DMSearchResult } from "../api/dm";
import type { DMChannelWithUser, DMMessage, ReactionGroup } from "../types";
import { useToastStore } from "./toastStore";
import { useE2EEStore } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import { encryptDMMessage, decryptDMMessages } from "../crypto/dmEncryption";

const EMPTY_CHANNELS: DMChannelWithUser[] = [];
const EMPTY_MESSAGES: DMMessage[] = [];
const EMPTY_STRINGS: string[] = [];

/**
 * sortChannelsByActivity — DM kanallarını sıralar.
 * Pinned DM'ler en üstte, kendi aralarında activity sıralı.
 * Sonra diğer DM'ler activity sıralı.
 * last_message_at null ise created_at'e fallback edilir.
 */
function sortChannelsByActivity(channels: DMChannelWithUser[]): DMChannelWithUser[] {
  return [...channels].sort((a, b) => {
    // Pinned olanlar en üstte
    if (a.is_pinned && !b.is_pinned) return -1;
    if (!a.is_pinned && b.is_pinned) return 1;
    // Aynı pin durumunda — activity sıralı
    const aTime = a.last_message_at ?? a.created_at;
    const bTime = b.last_message_at ?? b.created_at;
    return bTime.localeCompare(aTime);
  });
}

/** Typing indicator otomatik temizleme süresi (ms) */
const TYPING_TIMEOUT = 5_000;

/** Typing timer'ları: `channelId:username` → timeout ID */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

type DMState = {
  /** Tüm DM kanalları */
  channels: DMChannelWithUser[];
  /** Seçili DM kanalı ID'si */
  selectedDMId: string | null;
  /** DM mesaj cache'i: channelId → DMMessage[] */
  messagesByChannel: Record<string, DMMessage[]>;
  /** Kanal bazlı "daha eski mesaj var mı?" */
  hasMoreByChannel: Record<string, boolean>;
  /** DM okunmamış mesaj sayıları: channelId → count */
  dmUnreadCounts: Record<string, number>;
  /** Yüklenme durumları */
  isLoading: boolean;
  isLoadingMessages: boolean;

  // ─── Reply State ───
  /** Yanıt verilmekte olan mesaj (input üstünde ReplyBar gösterilir) */
  replyingTo: DMMessage | null;
  /** Scroll-to-message: Bu ID'ye sahip mesaja scroll et ve highlight yap */
  scrollToMessageId: string | null;

  // ─── Typing State ───
  /** Kanal bazlı typing kullanıcıları: channelId → username[] */
  typingUsers: Record<string, string[]>;

  // ─── DM Settings State ───
  /** Context menu "Mesajlarda Ara" → DM aç + search panel aktif */
  pendingSearchChannelId: string | null;

  // ─── Actions ───
  fetchChannels: () => Promise<void>;
  selectDM: (channelId: string | null) => void;
  createOrGetChannel: (userId: string) => Promise<string | null>;
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: DMMessage | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string) => Promise<void>;

  // ─── Pin ───
  pinMessage: (channelId: string, messageId: string) => Promise<void>;
  unpinMessage: (channelId: string, messageId: string) => Promise<void>;
  getPinnedMessages: (channelId: string) => Promise<DMMessage[]>;

  // ─── Search ───
  searchMessages: (channelId: string, query: string, limit?: number, offset?: number) => Promise<DMSearchResult>;

  // ─── Unread ───
  /** DM okunmamış sayacını artır (mesaj başka birinden geldiğinde) */
  incrementDMUnread: (channelId: string) => void;
  /** DM mesaj silindiğinde okunmamış sayacını azalt (0'ın altına düşmez) */
  decrementDMUnread: (channelId: string) => void;
  /** DM okunmamış sayacını sıfırla (kanal açıldığında) */
  clearDMUnread: (channelId: string) => void;
  /** Toplam DM okunmamış sayısı */
  getTotalDMUnread: () => number;

  // ─── DM Settings Actions ───
  /** Sidebar'dan gizle (backend + lokal state) */
  hideDM: (channelId: string) => Promise<void>;
  /** Sohbeti sabitle/kaldır */
  pinDM: (channelId: string) => Promise<void>;
  unpinDM: (channelId: string) => Promise<void>;
  /** Sessize al (duration: "1h"/"8h"/"7d"/"forever") */
  muteDM: (channelId: string, duration: string) => Promise<void>;
  unmuteDM: (channelId: string) => Promise<void>;
  /** Initial load: pinned + muted ID'leri çek → channels'a merge et */
  fetchDMSettings: () => Promise<void>;
  /** Context menu → arama paneli tetikleme */
  setPendingSearchChannelId: (id: string | null) => void;

  // ─── WS Event Handlers ───
  handleDMChannelCreate: (channel: DMChannelWithUser) => void;
  handleDMMessageCreate: (message: DMMessage) => void;
  handleDMMessageUpdate: (message: DMMessage) => void;
  handleDMMessageDelete: (data: { id: string; dm_channel_id: string }) => void;
  handleDMReactionUpdate: (data: { dm_message_id: string; dm_channel_id: string; reactions: ReactionGroup[] }) => void;
  handleDMTypingStart: (channelId: string, username: string) => void;
  handleDMMessagePin: (data: { dm_channel_id: string; message: DMMessage }) => void;
  handleDMMessageUnpin: (data: { dm_channel_id: string; message_id: string }) => void;
  /** DM settings WS event: hide/pin/mute değişikliği */
  handleDMSettingsUpdate: (data: { dm_channel_id: string; action: string }) => void;

  // ─── Helpers ───
  getMessagesForChannel: (channelId: string) => DMMessage[];
  getTypingUsers: (channelId: string) => string[];
};

export const useDMStore = create<DMState>((set, get) => ({
  channels: EMPTY_CHANNELS,
  selectedDMId: null,
  messagesByChannel: {},
  hasMoreByChannel: {},
  dmUnreadCounts: {},
  isLoading: false,
  isLoadingMessages: false,
  replyingTo: null,
  scrollToMessageId: null,
  typingUsers: {},
  pendingSearchChannelId: null,

  fetchChannels: async () => {
    set({ isLoading: true });
    const res = await dmApi.listDMChannels();
    if (res.success && res.data) {
      set({ channels: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  selectDM: (channelId) => {
    set({ selectedDMId: channelId });
  },

  createOrGetChannel: async (userId) => {
    const res = await dmApi.createDMChannel(userId);
    if (res.success && res.data) {
      // Kanal zaten listede yoksa ekle
      set((state) => {
        const exists = state.channels.some((ch) => ch.id === res.data!.id);
        if (exists) return state;
        return { channels: [res.data!, ...state.channels] };
      });
      return res.data.id;
    }
    return null;
  },

  fetchMessages: async (channelId) => {
    if (get().messagesByChannel[channelId]) return;
    set({ isLoadingMessages: true });

    const res = await dmApi.getDMMessages(channelId, undefined, 50);
    if (res.success && res.data) {
      // E2EE mesajlari decrypt et (encryption_version=0 olanlara dokunmaz)
      const messages = await decryptDMMessages(res.data!.messages ?? []);

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: messages,
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
        isLoadingMessages: false,
      }));
    } else {
      set({ isLoadingMessages: false });
    }
  },

  fetchOlderMessages: async (channelId) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    const beforeId = messages[0].id;
    const res = await dmApi.getDMMessages(channelId, beforeId, 50);
    if (res.success && res.data) {
      // E2EE mesajlari decrypt et
      const decrypted = await decryptDMMessages(res.data!.messages);

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...decrypted, ...state.messagesByChannel[channelId]],
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
      }));
    }
  },

  /**
   * sendMessage — DM mesajı gönderir.
   *
   * E2EE aktifse:
   * 1. Alıcının tüm cihazları için prekey bundle çek
   * 2. Her cihaz için Signal Protocol ile şifrele
   * 3. Kendi diğer cihazları için de şifrele (self-fanout)
   * 4. sendEncryptedDMMessage ile gönder
   *
   * E2EE aktif değilse plaintext olarak gönderir (legacy).
   */
  sendMessage: async (channelId, content, files, replyToId) => {
    const e2eeState = useE2EEStore.getState();

    // E2EE aktif — şifreli gönder
    if (e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const channel = get().channels.find((ch) => ch.id === channelId);
      const currentUserId = useAuthStore.getState().user?.id;

      if (channel && currentUserId) {
        try {
          const envelopes = await encryptDMMessage(
            currentUserId,
            channel.other_user.id,
            e2eeState.localDeviceId,
            content
          );

          const ciphertext = JSON.stringify(envelopes);
          // e2ee_metadata: sunucunun ihtiyaç duyabileceği ek bilgiler
          // (şu an boş — mentions DM'de sunucu tarafında işlenmiyor)
          const metadata = JSON.stringify({});

          const res = await dmApi.sendEncryptedDMMessage(
            channelId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata,
            files,
            replyToId
          );

          if (!res.success && res.error?.includes("too many")) {
            useToastStore.getState().addToast("warning", i18n.t("chat:tooManyMessages"));
          }

          return res.success;
        } catch (err) {
          console.error("[dmStore] E2EE encrypt failed:", err);
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // E2EE aktif değil — plaintext gönder (legacy)
    const res = await dmApi.sendDMMessage(channelId, content, files, replyToId);

    if (!res.success && res.error?.includes("too many")) {
      useToastStore.getState().addToast("warning", i18n.t("chat:tooManyMessages"));
    }

    return res.success;
  },

  editMessage: async (messageId, content) => {
    const e2eeState = useE2EEStore.getState();

    // E2EE aktifse şifreli edit gönder
    if (e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      // Düzenlenen mesajı bul — hangi kanala ait olduğunu ve alıcıyı belirle
      const state = get();
      let recipientUserId: string | null = null;
      for (const [chId, msgs] of Object.entries(state.messagesByChannel)) {
        if (msgs.some((m) => m.id === messageId)) {
          const channel = state.channels.find((ch) => ch.id === chId);
          if (channel) recipientUserId = channel.other_user.id;
          break;
        }
      }

      const currentUserId = useAuthStore.getState().user?.id;

      if (recipientUserId && currentUserId) {
        try {
          const envelopes = await encryptDMMessage(
            currentUserId,
            recipientUserId,
            e2eeState.localDeviceId,
            content
          );

          const ciphertext = JSON.stringify(envelopes);
          const metadata = JSON.stringify({});

          const res = await dmApi.editEncryptedDMMessage(
            messageId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata
          );
          return res.success;
        } catch (err) {
          console.error("[dmStore] E2EE edit encrypt failed:", err);
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // Plaintext edit
    const res = await dmApi.editDMMessage(messageId, content);
    return res.success;
  },

  deleteMessage: async (messageId) => {
    const res = await dmApi.deleteDMMessage(messageId);
    return res.success;
  },

  // ─── Reply Actions ───

  setReplyingTo: (message) => set({ replyingTo: message }),

  /**
   * setScrollToMessageId — Belirtilen mesaja scroll et.
   * Değer set edildikten sonra UI tarafında scrollIntoView + highlight yapılır,
   * ardından null'a sıfırlanır (tek seferlik tetikleme).
   */
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),

  // ─── Reactions ───

  /**
   * toggleReaction — Bir DM mesajına emoji reaction ekler veya kaldırır.
   *
   * API çağrısı yapar, sonuç WS broadcast ile gelecek (handleDMReactionUpdate).
   * Optimistic update yapmıyoruz — WS event ile güncellenecek.
   */
  toggleReaction: async (messageId, _channelId, emoji) => {
    await dmApi.toggleDMReaction(messageId, emoji);
  },

  // ─── Pin ───

  pinMessage: async (_channelId, messageId) => {
    await dmApi.pinDMMessage(messageId);
    // WS event (dm_message_pin) ile state güncellenecek
  },

  unpinMessage: async (_channelId, messageId) => {
    await dmApi.unpinDMMessage(messageId);
    // WS event (dm_message_unpin) ile state güncellenecek
  },

  getPinnedMessages: async (channelId) => {
    const res = await dmApi.getDMPinnedMessages(channelId);
    if (res.success && res.data) {
      return res.data;
    }
    return [];
  },

  // ─── Search ───

  searchMessages: async (channelId, query, limit = 25, offset = 0) => {
    const res = await dmApi.searchDMMessages(channelId, query, limit, offset);
    if (res.success && res.data) {
      return res.data;
    }
    return { messages: [], total_count: 0 };
  },

  // ─── DM Settings Actions ───

  /**
   * hideDM — DM kanalını sidebar'dan gizler.
   * Backend'e POST gönderir, başarılıysa lokal channels'dan çıkarır.
   * Yeni mesaj gelince backend otomatik unhide yapar → WS ile geri gelir.
   */
  hideDM: async (channelId) => {
    const res = await dmApi.hideDM(channelId);
    if (res.success) {
      set((state) => ({
        channels: state.channels.filter((ch) => ch.id !== channelId),
        // Eğer gizlenen kanal seçiliyse seçimi temizle
        selectedDMId: state.selectedDMId === channelId ? null : state.selectedDMId,
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmClosed"));
    }
  },

  /**
   * pinDM — DM sohbetini sabitler.
   * Backend'e POST gönderir, başarılıysa lokal is_pinned güncelle + sırala.
   */
  pinDM: async (channelId) => {
    const res = await dmApi.pinDMConversation(channelId);
    if (res.success) {
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) =>
            ch.id === channelId ? { ...ch, is_pinned: true } : ch
          )
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmPinned"));
    }
  },

  unpinDM: async (channelId) => {
    const res = await dmApi.unpinDMConversation(channelId);
    if (res.success) {
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) =>
            ch.id === channelId ? { ...ch, is_pinned: false } : ch
          )
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmUnpinned"));
    }
  },

  /**
   * muteDM — DM sohbetini sessize alır.
   * Duration: "1h" / "8h" / "7d" / "forever"
   */
  muteDM: async (channelId, duration) => {
    const res = await dmApi.muteDM(channelId, duration);
    if (res.success) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, is_muted: true } : ch
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmMuted"));
    }
  },

  unmuteDM: async (channelId) => {
    const res = await dmApi.unmuteDM(channelId);
    if (res.success) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, is_muted: false } : ch
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmUnmuted"));
    }
  },

  /**
   * fetchDMSettings — Pinned + muted DM ID'lerini çeker.
   * Initial load'da channels listesi ile birlikte çağrılır.
   * Backend'den gelen ID'ler ile lokal channels'ın is_pinned/is_muted'ını senkronize eder.
   */
  fetchDMSettings: async () => {
    const res = await dmApi.getDMSettings();
    if (res.success && res.data) {
      const pinnedSet = new Set(res.data.pinned_channel_ids ?? []);
      const mutedSet = new Set(res.data.muted_channel_ids ?? []);
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) => ({
            ...ch,
            is_pinned: pinnedSet.has(ch.id),
            is_muted: mutedSet.has(ch.id),
          }))
        ),
      }));
    }
  },

  setPendingSearchChannelId: (id) => set({ pendingSearchChannelId: id }),

  // ─── Unread ───

  incrementDMUnread: (channelId) => {
    set((state) => ({
      dmUnreadCounts: {
        ...state.dmUnreadCounts,
        [channelId]: (state.dmUnreadCounts[channelId] ?? 0) + 1,
      },
    }));
  },

  decrementDMUnread: (channelId) => {
    set((state) => {
      const current = state.dmUnreadCounts[channelId] ?? 0;
      if (current <= 0) return state;

      if (current === 1) {
        const next = { ...state.dmUnreadCounts };
        delete next[channelId];
        return { dmUnreadCounts: next };
      }

      return {
        dmUnreadCounts: {
          ...state.dmUnreadCounts,
          [channelId]: current - 1,
        },
      };
    });
  },

  clearDMUnread: (channelId) => {
    set((state) => {
      if (!state.dmUnreadCounts[channelId]) return state;
      const next = { ...state.dmUnreadCounts };
      delete next[channelId];
      return { dmUnreadCounts: next };
    });
  },

  getTotalDMUnread: () => {
    const counts = get().dmUnreadCounts;
    return Object.values(counts).reduce((sum, c) => sum + c, 0);
  },

  // ─── WS Event Handlers ───

  handleDMChannelCreate: (channel) => {
    set((state) => {
      // Duplicate kontrolü
      if (state.channels.some((ch) => ch.id === channel.id)) return state;
      return { channels: [channel, ...state.channels] };
    });
  },

  handleDMMessageCreate: (message) => {
    set((state) => {
      // Kanal sıralamasını güncelle — mesaj cache yüklü olmasa bile çalışır
      const updatedChannels = state.channels.map((ch) =>
        ch.id === message.dm_channel_id
          ? { ...ch, last_message_at: message.created_at }
          : ch
      );
      const sortedChannels = sortChannelsByActivity(updatedChannels);

      // Typing indicator'ı temizle (mesaj geldi = yazmayı bitirdi)
      const typingUsers = { ...state.typingUsers };
      if (typingUsers[message.dm_channel_id]) {
        typingUsers[message.dm_channel_id] = typingUsers[message.dm_channel_id].filter(
          (u) => u !== message.author?.username
        );
      }

      // Mesaj cache'i yüklenmemişse sadece kanal sırasını güncelle
      const channelMessages = state.messagesByChannel[message.dm_channel_id];
      if (!channelMessages) {
        return { channels: sortedChannels, typingUsers };
      }

      // Duplicate kontrolü
      if (channelMessages.some((m) => m.id === message.id)) {
        return { channels: sortedChannels, typingUsers };
      }

      return {
        channels: sortedChannels,
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.dm_channel_id]: [...channelMessages, message],
        },
        typingUsers,
      };
    });
  },

  handleDMMessageUpdate: (message) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[message.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.dm_channel_id]: channelMessages.map((m) =>
            m.id === message.id ? message : m
          ),
        },
      };
    });
  },

  /**
   * handleDMMessageDelete — DM mesajı silindiğinde çağrılır.
   *
   * Silinen mesajı listeden çıkarır + ona reply yapan mesajların
   * referenced_message'ını null'a çevir → "Orijinal mesaj silindi" gösterilir.
   * (Channel messageStore ile aynı pattern)
   */
  handleDMMessageDelete: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      const updated = channelMessages
        .filter((m) => m.id !== data.id)
        .map((m) =>
          m.reply_to_id === data.id
            ? { ...m, referenced_message: { id: data.id, author: null, content: null } }
            : m
        );

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: updated,
        },
      };
    });
  },

  /**
   * handleDMReactionUpdate — WS dm_reaction_update event'i geldiğinde çağrılır.
   *
   * Backend her toggle sonrası tam reaction listesini gönderir —
   * doğrudan replace (channel messageStore ile aynı pattern).
   */
  handleDMReactionUpdate: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.dm_message_id
              ? { ...m, reactions: data.reactions }
              : m
          ),
        },
      };
    });
  },

  /**
   * handleDMTypingStart — DM kanalında kullanıcı yazmaya başladığında çağrılır.
   *
   * 5 saniye sonra otomatik temizlenir (kullanıcı yazmayı bırakırsa
   * yeni typing event gelmez → timer ile temizlenir).
   * (Channel messageStore handleTypingStart ile aynı pattern)
   */
  handleDMTypingStart: (channelId, username) => {
    set((state) => {
      const current = state.typingUsers[channelId] ?? [];
      if (current.includes(username)) return state;

      return {
        typingUsers: {
          ...state.typingUsers,
          [channelId]: [...current, username],
        },
      };
    });

    // Mevcut timer'ı iptal et ve yenisini kur
    const key = `${channelId}:${username}`;
    const existingTimer = typingTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    typingTimers.set(
      key,
      setTimeout(() => {
        set((state) => ({
          typingUsers: {
            ...state.typingUsers,
            [channelId]: (state.typingUsers[channelId] ?? []).filter(
              (u) => u !== username
            ),
          },
        }));
        typingTimers.delete(key);
      }, TYPING_TIMEOUT)
    );
  },

  /**
   * handleDMMessagePin — DM mesajı sabitlendiğinde çağrılır.
   *
   * Backend tam enriched DMMessage gönderir — is_pinned:true.
   * Store'daki ilgili mesajı güncelle.
   */
  handleDMMessagePin: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.message.id ? { ...m, is_pinned: true } : m
          ),
        },
      };
    });
  },

  /**
   * handleDMMessageUnpin — DM mesajı pin'den çıkarıldığında çağrılır.
   *
   * Backend message_id gönderir — ilgili mesajın is_pinned'ını false yap.
   */
  handleDMMessageUnpin: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.message_id ? { ...m, is_pinned: false } : m
          ),
        },
      };
    });
  },

  /**
   * handleDMSettingsUpdate — WS dm_settings_update event'i geldiğinde çağrılır.
   *
   * Backend aksiyona göre payload gönderir:
   * - hide/unhide: kanalı listeden çıkar/ekle
   * - pin/unpin: is_pinned güncelle + sırala
   * - mute/unmute: is_muted güncelle
   */
  handleDMSettingsUpdate: (data) => {
    const { dm_channel_id, action } = data;

    switch (action) {
      case "hidden":
        set((state) => ({
          channels: state.channels.filter((ch) => ch.id !== dm_channel_id),
          selectedDMId: state.selectedDMId === dm_channel_id ? null : state.selectedDMId,
        }));
        break;

      case "unhidden":
        // Unhide geldiğinde channels listesini yeniden çek (yeni mesajla geri gelmiş olabilir)
        get().fetchChannels();
        break;

      case "pinned":
        set((state) => ({
          channels: sortChannelsByActivity(
            state.channels.map((ch) =>
              ch.id === dm_channel_id ? { ...ch, is_pinned: true } : ch
            )
          ),
        }));
        break;

      case "unpinned":
        set((state) => ({
          channels: sortChannelsByActivity(
            state.channels.map((ch) =>
              ch.id === dm_channel_id ? { ...ch, is_pinned: false } : ch
            )
          ),
        }));
        break;

      case "muted":
        set((state) => ({
          channels: state.channels.map((ch) =>
            ch.id === dm_channel_id ? { ...ch, is_muted: true } : ch
          ),
        }));
        break;

      case "unmuted":
        set((state) => ({
          channels: state.channels.map((ch) =>
            ch.id === dm_channel_id ? { ...ch, is_muted: false } : ch
          ),
        }));
        break;
    }
  },

  // ─── Helpers ───

  getMessagesForChannel: (channelId) => {
    return get().messagesByChannel[channelId] ?? EMPTY_MESSAGES;
  },

  getTypingUsers: (channelId) => {
    return get().typingUsers[channelId] ?? EMPTY_STRINGS;
  },
}));
