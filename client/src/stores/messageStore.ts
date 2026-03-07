/**
 * Message Store — Zustand ile mesaj state yönetimi.
 *
 * Tasarım kararları:
 * - messagesByChannel: Kanal değiştirince cache'den gösterir, yoksa fetch eder.
 *   Record<channelId, Message[]> formatında — her kanalın mesajları ayrı tutulur.
 * - Mesajlar created_at ASC sıralı (en eski üstte, en yeni altta).
 * - WebSocket "message_create" → dizinin sonuna ekler (yeni mesaj altta).
 * - Cursor pagination: fetchOlderMessages dizideki ilk mesajın ID'sini "before" olarak gönderir.
 * - typingUsers: Hangi kullanıcıların yazmakta olduğunu takip eder (typing indicator için).
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as messageApi from "../api/messages";
import * as reactionApi from "../api/reactions";
import { useServerStore } from "./serverStore";
import { useE2EEStore } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import { useReadStateStore } from "./readStateStore";
import { useToastStore } from "./toastStore";
import { encryptChannelMessage, decryptChannelMessages } from "../crypto/channelEncryption";
import { encryptFile } from "../crypto/fileEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import type { Message, ReactionGroup } from "../types";
import type { EncryptedFileMeta } from "../crypto/fileEncryption";
import { DEFAULT_MESSAGE_LIMIT } from "../utils/constants";

type MessageState = {
  /** Kanal bazlı mesaj cache'i: channelId → Message[] */
  messagesByChannel: Record<string, Message[]>;
  /** Kanal bazlı "daha eski mesaj var mı?" bilgisi */
  hasMoreByChannel: Record<string, boolean>;
  /** Yüklenme durumu (ilk yükleme) */
  isLoading: boolean;
  /** Daha eski mesajlar yüklenirken */
  isLoadingMore: boolean;
  /** Kanal bazlı typing kullanıcıları: channelId → username[] */
  typingUsers: Record<string, string[]>;

  // ─── Reply State ───
  /** Yanıt verilmekte olan mesaj (input üstünde ReplyBar gösterilir) */
  replyingTo: Message | null;
  /** Scroll-to-message: Bu ID'ye sahip mesaja scroll et ve highlight yap */
  scrollToMessageId: string | null;

  // ─── Actions ───
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  /** fetchedChannels cache'ini temizler — E2EE restore sonrasi mesajlarin yeniden decrypt edilmesi icin */
  invalidateFetchCache: () => void;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: Message | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string) => Promise<void>;

  // ─── WS Event Handlers ───
  handleMessageCreate: (message: Message) => void;
  handleMessageUpdate: (message: Message) => void;
  handleMessageDelete: (data: { id: string; channel_id: string }) => void;
  handleTypingStart: (channelId: string, username: string) => void;
  handleReactionUpdate: (data: { message_id: string; channel_id: string; reactions: ReactionGroup[] }) => void;
};

/** Typing indicator otomatik temizleme süresi (ms) */
const TYPING_TIMEOUT = 5_000;

/** Typing timer'ları: `channelId:username` → timeout ID */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * fetchedChannels — API'den başarıyla mesaj çekilmiş kanalları takip eder.
 *
 * Neden ayrı bir Set?
 * messagesByChannel[channelId] artık WS mesajlarını da buffer'lıyor (fetchMessages
 * tamamlanmadan gelen mesajlar). Eski cache guard `if (messagesByChannel[channelId]) return`
 * buffer'lanmış mesajları da "fetched" sanıyordu. Bu Set ile "API'den çekildi" ve
 * "WS'den buffer'landı" ayrımı net olur.
 */
const fetchedChannels = new Set<string>();

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChannel: {},
  hasMoreByChannel: {},
  isLoading: false,
  isLoadingMore: false,
  typingUsers: {},
  replyingTo: null,
  scrollToMessageId: null,

  invalidateFetchCache: () => {
    fetchedChannels.clear();
    set({ messagesByChannel: {}, hasMoreByChannel: {} });
  },

  /**
   * fetchMessages — Bir kanalın mesajlarını ilk kez yükler.
   * Cache'de varsa tekrar çekmez (kanal değiştirince hızlı geçiş).
   *
   * Merge mekanizması: fetchMessages çalışırken WS'den gelen mesajlar
   * handleMessageCreate tarafından buffer'lanır. API response geldiğinde
   * buffer'daki mesajlar API sonuçlarıyla merge edilir (duplicate'ler filtrelenir).
   */
  fetchMessages: async (channelId) => {
    // API'den zaten çekilmişse tekrar çekme.
    // fetchedChannels Set'i kullanılır — messagesByChannel'da WS buffer'ı
    // olabilir, bu "fetched" anlamına gelmez.
    if (fetchedChannels.has(channelId)) return;

    set({ isLoading: true });

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) { set({ isLoading: false }); return; }

    const res = await messageApi.getMessages(serverId, channelId, undefined, DEFAULT_MESSAGE_LIMIT);
    if (res.success && res.data) {
      fetchedChannels.add(channelId);

      // Backend boş kanalda messages: null dönebilir (Go nil slice → JSON null).
      // Null üzerinde .map() crash eder — boş array'e fallback.
      // E2EE mesajlari bulk decrypt et — plaintext mesajlar oldugu gibi kalir.
      const apiMessages = await decryptChannelMessages(res.data.messages ?? []);

      set((state) => {
        // Fetch sırasında WS'den buffer'lanmış mesajları al.
        // API response'ta olmayan WS mesajlarını sonuna ekle (daha yeni oldukları için).
        const buffered = state.messagesByChannel[channelId] ?? [];
        const apiIds = new Set(apiMessages.map((m) => m.id));
        const newFromWS = buffered.filter((m) => !apiIds.has(m.id));

        return {
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: [...apiMessages, ...newFromWS],
          },
          hasMoreByChannel: {
            ...state.hasMoreByChannel,
            [channelId]: res.data!.has_more,
          },
          isLoading: false,
        };
      });

      // Mesajlar yüklendikten sonra auto-mark-read:
      // Tüm mesajların (API + WS buffer) en sonuncusu ile backend'e bildir.
      // AppLayout'taki useEffect mesajlar yüklenmeden çalışabilir, bu yüzden
      // burada tekrar kontrol ediyoruz.
      const allMessages = get().messagesByChannel[channelId];
      if (allMessages && allMessages.length > 0) {
        const lastMsg = allMessages[allMessages.length - 1];
        useReadStateStore.getState().markAsRead(channelId, lastMsg.id);
      }
    } else {
      set({ isLoading: false });
    }
  },

  /**
   * fetchOlderMessages — Daha eski mesajları yükler (yukarı scroll).
   * Cursor: cache'deki ilk mesajın ID'si "before" parametresi olarak gönderilir.
   */
  fetchOlderMessages: async (channelId) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    set({ isLoadingMore: true });

    // İlk mesajın ID'si cursor olur (en eski mesaj dizinin başında)
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) { set({ isLoadingMore: false }); return; }

    const beforeId = messages[0].id;
    const res = await messageApi.getMessages(serverId, channelId, beforeId, DEFAULT_MESSAGE_LIMIT);

    if (res.success && res.data) {
      // E2EE mesajlari bulk decrypt et
      const decrypted = await decryptChannelMessages(res.data.messages ?? []);

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...decrypted, ...state.messagesByChannel[channelId]],
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
        isLoadingMore: false,
      }));
    } else {
      set({ isLoadingMore: false });
    }
  },

  sendMessage: async (channelId, content, files, replyToId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE aktifse Sender Key ile sifrele
    const e2eeState = useE2EEStore.getState();
    if (e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;
      if (currentUserId) {
        try {
          // Dosyalar varsa her birini AES-256-GCM ile sifrele
          let encryptedFiles: File[] | undefined;
          let fileMetas: EncryptedFileMeta[] | undefined;

          if (files && files.length > 0) {
            encryptedFiles = [];
            fileMetas = [];

            for (let i = 0; i < files.length; i++) {
              const result = await encryptFile(files[i]);
              // Sifreli blob'u File nesnesine cevir (FormData icin)
              encryptedFiles.push(
                new File(
                  [result.encryptedBlob],
                  `encrypted_${i}.bin`,
                  { type: "application/octet-stream" }
                )
              );
              fileMetas.push(result.meta);
            }
          }

          // Structured payload: content + file_keys (varsa) → JSON string
          const plaintext = encodePayload(content, fileMetas);

          const senderKeyMsg = await encryptChannelMessage(
            channelId,
            currentUserId,
            e2eeState.localDeviceId,
            plaintext
          );
          const ciphertext = JSON.stringify(senderKeyMsg);
          const metadata = JSON.stringify({
            distribution_id: senderKeyMsg.distributionId,
          });

          const res = await messageApi.sendEncryptedMessage(
            serverId,
            channelId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata,
            encryptedFiles,
            replyToId
          );

          if (!res.success && res.error?.includes("too many")) {
            useToastStore.getState().addToast("warning", i18n.t("chat:tooManyMessages"));
          }

          return res.success;
        } catch (err) {
          console.error("[messageStore] E2EE encryption failed:", err);
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // Plaintext fallback
    const res = await messageApi.sendMessage(serverId, channelId, content, files, replyToId);

    // Rate limit aşıldıysa kullanıcıya toast ile bildir
    if (!res.success && res.error?.includes("too many")) {
      useToastStore.getState().addToast("warning", i18n.t("chat:tooManyMessages"));
    }

    return res.success;
  },

  editMessage: async (messageId, content) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE aktifse sifreli edit
    const e2eeState = useE2EEStore.getState();
    if (e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;
      // Mesajin kanalini bul
      const allChannels = get().messagesByChannel;
      let channelId: string | null = null;
      for (const [chId, msgs] of Object.entries(allChannels)) {
        if (msgs.some((m) => m.id === messageId)) {
          channelId = chId;
          break;
        }
      }

      if (currentUserId && channelId) {
        try {
          const senderKeyMsg = await encryptChannelMessage(
            channelId,
            currentUserId,
            e2eeState.localDeviceId,
            content
          );
          const ciphertext = JSON.stringify(senderKeyMsg);
          const metadata = JSON.stringify({
            distribution_id: senderKeyMsg.distributionId,
          });

          const res = await messageApi.editEncryptedMessage(
            serverId,
            messageId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata
          );
          return res.success;
        } catch (err) {
          console.error("[messageStore] E2EE edit encryption failed:", err);
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // Plaintext fallback
    const res = await messageApi.editMessage(serverId, messageId, content);
    return res.success;
  },

  deleteMessage: async (messageId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const res = await messageApi.deleteMessage(serverId, messageId);
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
   * toggleReaction — Bir mesaja emoji reaction ekler veya kaldırır.
   *
   * API çağrısı yapar, sonuç WS broadcast ile gelecek (handleReactionUpdate).
   * Optimistic update yapmıyoruz — WS event ile güncellenecek.
   * Bu daha basit ve race condition riski yok.
   */
  toggleReaction: async (messageId, _channelId, emoji) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    await reactionApi.toggleReaction(serverId, messageId, emoji);
  },

  // ─── WebSocket Event Handlers ───

  /**
   * handleMessageCreate — Yeni mesaj geldiğinde çağrılır.
   * Mesajı ilgili kanalın dizisinin sonuna ekler (en yeni altta).
   * Aynı zamanda typing indicator'ı temizler (mesaj geldi = yazmayı bitirdi).
   */
  handleMessageCreate: (message) => {
    set((state) => {
      // Kanal henüz yüklenmemişse bile mesajı buffer'la.
      // fetchMessages tamamlandığında buffer'daki mesajlarla merge eder.
      // Eski davranış `if (!channelMessages) return state` idi — bu da fetch
      // sırasında gelen WS mesajlarının kaybolmasına neden oluyordu.
      const channelMessages = state.messagesByChannel[message.channel_id] ?? [];

      // Duplicate kontrolü (aynı mesaj iki kez gelmesin)
      if (channelMessages.some((m) => m.id === message.id)) return state;

      // Typing indicator'ı temizle
      const typingUsers = { ...state.typingUsers };
      if (typingUsers[message.channel_id]) {
        typingUsers[message.channel_id] = typingUsers[message.channel_id].filter(
          (u) => u !== message.author?.username
        );
      }

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channel_id]: [...channelMessages, message],
        },
        typingUsers,
      };
    });
  },

  handleMessageUpdate: (message) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[message.channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channel_id]: channelMessages.map((m) =>
            m.id === message.id ? message : m
          ),
        },
      };
    });
  },

  handleMessageDelete: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.channel_id];
      if (!channelMessages) return state;

      // Silinen mesajı listeden çıkar + ona reply yapan mesajların
      // referenced_message'ını null'a çevir → "Orijinal mesaj silindi" gösterilir.
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
          [data.channel_id]: updated,
        },
      };
    });
  },

  /**
   * handleTypingStart — Bir kullanıcı yazmaya başladığında çağrılır.
   *
   * 5 saniye sonra otomatik temizlenir (kullanıcı yazmayı bırakırsa
   * yeni typing event gelmez → timer ile temizlenir).
   */
  handleTypingStart: (channelId, username) => {
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
   * handleReactionUpdate — WS reaction_update event'i geldiğinde çağrılır.
   *
   * İlgili mesajın reactions alanını güncel listeyle değiştirir.
   * Backend her toggle sonrası tam reaction listesini gönderir —
   * bu sayede client-side merge'e gerek kalmaz, doğrudan replace.
   */
  handleReactionUpdate: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.channel_id]: channelMessages.map((m) =>
            m.id === data.message_id
              ? { ...m, reactions: data.reactions }
              : m
          ),
        },
      };
    });
  },
}));
