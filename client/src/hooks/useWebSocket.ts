/**
 * useWebSocket — WebSocket bağlantısı ve event routing hook'u.
 *
 * Bu hook tek bir yerde çalışır: AppLayout.tsx
 * Görevi:
 * 1. Kullanıcı login olduğunda WS bağlantısı kurmak
 * 2. Heartbeat göndermek (30sn interval, 3 miss = disconnect)
 * 3. Gelen event'leri ilgili store handler'larına yönlendirmek (switch/case)
 * 4. Bağlantı koptuğunda otomatik reconnect etmek (3sn delay)
 * 5. sendTyping fonksiyonunu expose etmek (MessageInput kullanır)
 *
 * WebSocket nedir?
 * HTTP'nin aksine bağlantı sürekli açık kalır.
 * Her iki taraf istediği zaman mesaj gönderebilir.
 * Chat uygulamaları için ideal — yeni mesaj geldiğinde
 * polling (sürekli sorma) yerine server anında bildirir.
 *
 * React StrictMode Sorunu ve Çözümü:
 * React 18 StrictMode development'ta component'leri mount → unmount → remount yapar.
 * Bu, WS bağlantısının açılıp hemen kapatılıp tekrar açılmasına neden olur.
 * Eski socket'in onclose callback'i hâlâ tetiklenebildiğinden, bağlantı sayısı
 * kontrolsüz artabilir.
 *
 * Çözüm: Her effect invocation'a benzersiz bir "connectionId" atıyoruz.
 * Socket callback'leri sadece kendi connectionId'si aktifse işlem yapıyor.
 * Unmount'ta ID sıfırlanmaz, artırılır — böylece ID çakışması imkansız olur.
 */

import { useEffect, useRef, useCallback } from "react";
import { getAccessToken } from "../api/client";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import { useMemberStore } from "../stores/memberStore";
import { useRoleStore } from "../stores/roleStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useServerStore } from "../stores/serverStore";
import { usePinStore } from "../stores/pinStore";
import { useReadStateStore } from "../stores/readStateStore";
import { useAuthStore } from "../stores/authStore";
import { useUIStore } from "../stores/uiStore";
import { useDMStore } from "../stores/dmStore";
import {
  WS_URL,
  WS_HEARTBEAT_INTERVAL,
  WS_HEARTBEAT_MAX_MISS,
} from "../utils/constants";
import { playJoinSound, playLeaveSound } from "../utils/sounds";
import type {
  WSMessage,
  Channel,
  Category,
  Message,
  MemberWithRoles,
  Role,
  Server,
  UserStatus,
  VoiceState,
  VoiceStateUpdateData,
  PinnedMessage,
  DMChannelWithUser,
  DMMessage,
  ReactionGroup,
} from "../types";

/** Reconnect denemesi arasındaki bekleme süresi (ms) */
const RECONNECT_DELAY = 3_000;

/** Typing throttle süresi (ms) — aynı kanala bu süreden sık typing gönderilmez */
const TYPING_THROTTLE = 3_000;

/**
 * useWebSocket — Ana WebSocket hook'u.
 *
 * Çağıran component'ten bağımsız çalışır (AppLayout'ta bir kez mount edilir).
 * Gelen event'leri channelStore ve messageStore'a yönlendirir.
 *
 * @returns sendTyping fonksiyonu — MessageInput'un klavye vuruşlarında çağırması için
 */
export function useWebSocket() {
  /** WebSocket instance referansı — closure'lar arasında paylaşılır */
  const wsRef = useRef<WebSocket | null>(null);

  /** Son alınan seq numarası — eksik event tespiti için */
  const lastSeqRef = useRef<number>(0);

  /** Heartbeat miss sayacı */
  const missedHeartbeatsRef = useRef<number>(0);

  /** Heartbeat interval ID'si */
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Reconnect timeout ID'si */
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Monoton artan bağlantı ID'si — React StrictMode koruması.
   *
   * Her useEffect invocation'ı kendi benzersiz ID'sini alır.
   * Socket callback'leri (onclose, onmessage) sadece kendi ID'si
   * hâlâ aktifse işlem yapar.
   *
   * NEDEN sıfırlama değil artırma?
   * Sıfırlama yapılırsa (0'a set) remount'ta ++0=1 olur — bu ilk mount'taki
   * ID (1) ile aynı! Eski socket'in geç gelen onclose'u eşleşir ve reconnect
   * tetikler. Artırma ile ID'ler her zaman benzersiz kalır.
   */
  const activeConnectionIdRef = useRef<number>(0);

  /** Son typing gönderme zamanı: channelId → timestamp */
  const lastTypingRef = useRef<Map<string, number>>(new Map());

  /**
   * routeEventRef — routeEvent fonksiyonunun en güncel versiyonunu tutan ref.
   *
   * Neden ref kullanıyoruz?
   * routeEvent fonksiyonu her render'da yeniden oluşturulur. Ancak WebSocket'in
   * onmessage callback'i useEffect'teki ilk render'ın closure'ını yakalar.
   * Vite HMR modülü güncellediğinde component re-render olur ama useEffect
   * (boş deps) yeniden çalışmaz — yani onmessage ESKİ routeEvent'i kullanır.
   *
   * Ref pattern çözümü:
   * 1. Her render'da routeEvent yeniden tanımlanır (en güncel logic ile)
   * 2. routeEventRef.current = routeEvent; ile ref güncellenir
   * 3. onmessage'daki kod routeEventRef.current(msg) çağırır
   * 4. Böylece her zaman en güncel event handler çalışır
   *
   * Bu pattern özellikle persistent WebSocket bağlantılarında yaygındır —
   * "latest ref" pattern olarak bilinir.
   */
  const routeEventRef = useRef<(msg: WSMessage) => void>(() => {});

  /**
   * routeEvent — Gelen WS event'ini op koduna göre ilgili store handler'ına yönlendirir.
   *
   * Bu fonksiyon WebSocket mesajlarının "switch/case" dağıtıcısıdır.
   * Her yeni event türü eklendiğinde buraya bir case eklenir.
   *
   * Store'lara doğrudan getState() ile erişiyoruz (Zustand).
   * Bu, React render cycle'ından bağımsız çalışmamızı sağlar.
   */
  function routeEvent(msg: WSMessage) {
    switch (msg.op) {
      // ─── Heartbeat ───
      case "heartbeat_ack":
        missedHeartbeatsRef.current = 0;
        break;

      // ─── Channel Events ───
      case "channel_create":
        useChannelStore.getState().handleChannelCreate(msg.d as Channel);
        break;
      case "channel_update":
        useChannelStore.getState().handleChannelUpdate(msg.d as Channel);
        break;
      case "channel_delete":
        useChannelStore.getState().handleChannelDelete((msg.d as { id: string }).id);
        break;

      // ─── Category Events ───
      case "category_create":
        useChannelStore.getState().handleCategoryCreate(msg.d as Category);
        break;
      case "category_update":
        useChannelStore.getState().handleCategoryUpdate(msg.d as Category);
        break;
      case "category_delete":
        useChannelStore.getState().handleCategoryDelete((msg.d as { id: string }).id);
        break;

      // ─── Message Events ───
      case "message_create": {
        const message = msg.d as Message;
        useMessageStore.getState().handleMessageCreate(message);

        // Kendi gönderdiğimiz mesajlar için unread artırma.
        // Server message_create'i tüm bağlı kullanıcılara broadcast eder —
        // gönderen de dahil. Kendi mesajımızı "okunmamış" saymamalıyız.
        const currentUserId = useAuthStore.getState().user?.id;
        if (message.author?.id === currentUserId || message.user_id === currentUserId) {
          break;
        }

        // Okunmamış sayacı: kullanıcı o kanalı aktif olarak GÖRÜYOR MU?
        // uiStore'daki aktif tab'ın tipini ve channelId'sini doğrudan kontrol ediyoruz.
        // Bu yaklaşım selectedDMId'ye bağımlı değildir — tab type "text" ve channelId
        // eşleşiyorsa kullanıcı o kanalı görüyor demektir. Diğer tüm durumlar
        // (DM tab, voice tab, farklı kanal) → unread artır.
        const uiState = useUIStore.getState();
        const panel = uiState.panels[uiState.activePanelId];
        const activeTab = panel?.tabs.find((t) => t.id === panel.activeTabId);
        const isViewingThisChannel =
          activeTab?.type === "text" && activeTab?.channelId === message.channel_id;

        if (isViewingThisChannel) {
          // Aktif text kanalına gelen mesaj — watermark'ı güncelle (fire-and-forget)
          useReadStateStore.getState().markAsRead(message.channel_id, message.id);
        } else {
          useReadStateStore.getState().incrementUnread(message.channel_id);
        }
        break;
      }
      case "message_update":
        useMessageStore.getState().handleMessageUpdate(msg.d as Message);
        break;
      case "message_delete":
        useMessageStore.getState().handleMessageDelete(
          msg.d as { id: string; channel_id: string }
        );
        break;

      // ─── Typing ───
      case "typing_start": {
        const data = msg.d as { channel_id: string; username: string };
        useMessageStore.getState().handleTypingStart(data.channel_id, data.username);
        break;
      }

      // ─── Presence & Member Events ───
      case "ready": {
        const data = msg.d as { online_user_ids: string[] };
        useMemberStore.getState().handleReady(data.online_user_ids);
        // WS bağlantısı kurulduğunda (ilk bağlantı veya reconnect) okunmamış sayıları çek
        useReadStateStore.getState().fetchUnreadCounts();
        // DM kanallarını çek — DM listesinin hemen hazır olması için
        useDMStore.getState().fetchChannels();
        break;
      }
      case "presence_update": {
        const data = msg.d as { user_id: string; status: UserStatus };
        useMemberStore.getState().handlePresenceUpdate(data.user_id, data.status);
        break;
      }
      case "member_join":
        useMemberStore.getState().handleMemberJoin(msg.d as MemberWithRoles);
        break;
      case "member_leave":
        useMemberStore.getState().handleMemberLeave(
          (msg.d as { user_id: string }).user_id
        );
        break;
      case "member_update":
        useMemberStore.getState().handleMemberUpdate(msg.d as MemberWithRoles);
        break;

      // ─── Role Events ───
      // Her iki store'a da yönlendir:
      // memberStore: üye listesindeki rol bilgilerini günceller
      // roleStore: settings panelindeki rol listesini günceller
      case "role_create": {
        const role = msg.d as Role;
        useMemberStore.getState().handleRoleCreate(role);
        useRoleStore.getState().handleRoleCreate(role);
        break;
      }
      case "role_update": {
        const role = msg.d as Role;
        useMemberStore.getState().handleRoleUpdate(role);
        useRoleStore.getState().handleRoleUpdate(role);
        break;
      }
      case "role_delete": {
        const roleId = (msg.d as { id: string }).id;
        useMemberStore.getState().handleRoleDelete(roleId);
        useRoleStore.getState().handleRoleDelete(roleId);
        break;
      }

      // ─── Voice Events ───
      case "voice_state_update": {
        const voiceData = msg.d as VoiceStateUpdateData;
        useVoiceStore.getState().handleVoiceStateUpdate(voiceData);

        // Join/Leave sesleri — sadece başka kullanıcıların giriş/çıkışlarında çal.
        // Kendi join/leave event'imiz için ses çalmayız (zaten biliyoruz).
        const myUserId = useAuthStore.getState().user?.id;
        if (voiceData.user_id !== myUserId) {
          if (voiceData.action === "join") {
            playJoinSound();
          } else if (voiceData.action === "leave") {
            playLeaveSound();
          }
        }
        break;
      }
      case "voice_states_sync": {
        const syncData = msg.d as { states: VoiceState[] };
        useVoiceStore.getState().handleVoiceStatesSync(syncData.states);
        break;
      }

      // ─── Pin Events ───
      case "message_pin":
        usePinStore.getState().handleMessagePin(msg.d as PinnedMessage);
        break;
      case "message_unpin":
        usePinStore.getState().handleMessageUnpin(
          msg.d as { message_id: string; channel_id: string }
        );
        break;

      // ─── Reaction Events ───
      case "reaction_update": {
        const reactionData = msg.d as {
          message_id: string;
          channel_id: string;
          reactions: ReactionGroup[];
        };
        useMessageStore.getState().handleReactionUpdate(reactionData);
        break;
      }

      // ─── DM Events ───
      case "dm_channel_create":
        useDMStore.getState().handleDMChannelCreate(msg.d as DMChannelWithUser);
        break;
      case "dm_message_create": {
        const dmMsg = msg.d as DMMessage;
        useDMStore.getState().handleDMMessageCreate(dmMsg);

        // Kendi gönderdiğimiz mesajlar için unread artırma (server echo).
        // Server dm_message_create'i hem gönderene hem alıcıya broadcast eder.
        const currentUserId = useAuthStore.getState().user?.id;
        if (dmMsg.user_id === currentUserId) break;

        // DM okunmamış sayacı: mesaj aktif DM tab'ına ait değilse artır.
        const dmState = useDMStore.getState();
        const activeDMId = dmState.selectedDMId;
        if (dmMsg.dm_channel_id !== activeDMId) {
          dmState.incrementDMUnread(dmMsg.dm_channel_id);
        }
        break;
      }
      case "dm_message_update":
        useDMStore.getState().handleDMMessageUpdate(msg.d as DMMessage);
        break;
      case "dm_message_delete":
        useDMStore.getState().handleDMMessageDelete(
          msg.d as { id: string; dm_channel_id: string }
        );
        break;

      // ─── Server Events ───
      case "server_update":
        useServerStore.getState().handleServerUpdate(msg.d as Server);
        break;
    }
  }

  // routeEventRef'i her render'da güncel tut.
  // Böylece WebSocket'in onmessage callback'i her zaman en güncel
  // routeEvent fonksiyonunu çağırır (HMR + closure freshness).
  routeEventRef.current = routeEvent;

  /** cleanupTimers — Interval ve timeout'ları temizler */
  function cleanupTimers() {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }

  /**
   * sendTyping — MessageInput'un her keystroke'da çağırdığı fonksiyon.
   *
   * Throttle mekanizması: Aynı kanala 3 saniyeden sık typing gönderilmez.
   * Bu, sunucunun gereksiz typing event'leri ile flood edilmesini önler.
   */
  const sendTyping = useCallback((channelId: string) => {
    const now = Date.now();
    const lastSent = lastTypingRef.current.get(channelId) ?? 0;

    if (now - lastSent < TYPING_THROTTLE) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "typing",
          d: { channel_id: channelId },
        })
      );
      lastTypingRef.current.set(channelId, now);
    }
  }, []);

  /**
   * sendVoiceJoin — Ses kanalına katılma WS event'i gönderir.
   * VoiceService'in JoinChannel metodunu tetikler (Hub callback üzerinden).
   */
  const sendVoiceJoin = useCallback((channelId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "voice_join",
          d: { channel_id: channelId },
        })
      );
    }
  }, []);

  /**
   * sendVoiceLeave — Ses kanalından ayrılma WS event'i gönderir.
   * VoiceService'in LeaveChannel metodunu tetikler.
   */
  const sendVoiceLeave = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "voice_leave",
        })
      );
    }
  }, []);

  /**
   * sendPresenceUpdate — Kullanıcının presence durumunu güncelleme WS event'i gönderir.
   *
   * Idle detection hook'u tarafından çağrılır:
   * - 5dk inaktiflik → sendPresenceUpdate("idle")
   * - Aktivite geri geldiğinde → sendPresenceUpdate("online")
   * - Manuel DND toggle → sendPresenceUpdate("dnd")
   *
   * Backend'de: handlePresenceUpdate → DB persist + broadcast tüm client'lara.
   */
  const sendPresenceUpdate = useCallback((status: UserStatus) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "presence_update",
          d: { status },
        })
      );
    }
  }, []);

  /**
   * sendVoiceStateUpdate — Mute/deafen/stream durumunu güncelleme WS event'i gönderir.
   * VoiceService'in UpdateState metodunu tetikler.
   *
   * Partial update: sadece değişen alanlar gönderilir (undefined olanlar gönderilmez).
   */
  const sendVoiceStateUpdate = useCallback(
    (state: { is_muted?: boolean; is_deafened?: boolean; is_streaming?: boolean }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            op: "voice_state_update_request",
            d: state,
          })
        );
      }
    },
    []
  );

  // ─── Effect: Mount/unmount lifecycle ───
  useEffect(() => {
    /**
     * Bu effect her mount'ta çalışır.
     * myId, bu effect invocation'ına özel benzersiz bir tanımlayıcı.
     * Tüm socket callback'leri myId'yi closure ile yakalar.
     *
     * StrictMode akışı:
     * 1. mount  → myId=1, socket A açılır
     * 2. unmount → activeConnectionIdRef++=2, socket A kapatılır
     * 3. remount → myId=3, socket B açılır
     * 4. Socket A'nın geç gelen onclose'u: activeRef(3) !== myId(1) → SKIP
     *
     * ID'ler: 1, 2(invalidate), 3 — çakışma imkansız.
     */
    const myId = ++activeConnectionIdRef.current;

    /**
     * doConnect — Bu effect scope'u içinde WS bağlantısı kurar.
     *
     * Neden useCallback yerine burada tanımlanıyor?
     * - myId'yi closure ile yakalar — her effect invocation'ı kendi ID'sini bilir
     * - Reconnect'te aynı myId'yi kullanır — effect scope boyunca tutarlı
     * - useCallback'in stale closure riski yok
     */
    function doConnect() {
      const token = getAccessToken();
      if (!token || activeConnectionIdRef.current !== myId) return;

      // Önceki bağlantıyı ve timer'ları temizle
      cleanupTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const socket = new WebSocket(`${WS_URL}?token=${token}`);
      wsRef.current = socket;

      // ─── onopen ───
      socket.onopen = () => {
        // Stale socket kontrolü
        if (activeConnectionIdRef.current !== myId) return;

        missedHeartbeatsRef.current = 0;

        // Heartbeat interval başlat
        heartbeatIntervalRef.current = setInterval(() => {
          if (activeConnectionIdRef.current !== myId) {
            // Bu interval artık stale — temizle
            clearInterval(heartbeatIntervalRef.current!);
            return;
          }

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "heartbeat" }));
            missedHeartbeatsRef.current++;

            if (missedHeartbeatsRef.current >= WS_HEARTBEAT_MAX_MISS) {
              // 3 heartbeat miss → bağlantı kopmuş, yeniden bağlan
              socket.close();
            }
          }
        }, WS_HEARTBEAT_INTERVAL);
      };

      // ─── onmessage ───
      socket.onmessage = (event: MessageEvent) => {
        // Stale socket kontrolü
        if (activeConnectionIdRef.current !== myId) return;

        let msg: WSMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return; // Parse edilemezse yoksay
        }

        // Seq tracking
        if (msg.seq) {
          lastSeqRef.current = msg.seq;
        }

        // Event routing — ref üzerinden en güncel handler'ı çağır.
        // routeEvent doğrudan çağrılsa closure'daki ilk render versiyonu kullanılırdı.
        // routeEventRef.current her render'da güncellenir → her zaman en güncel logic.
        routeEventRef.current(msg);
      };

      // ─── onclose ───
      socket.onclose = () => {
        /**
         * Stale socket kontrolü — KRITIK NOKTA.
         *
         * Bu socket'in myId'si artık aktif değilse (başka bir connect çalışıyorsa
         * veya component unmount olduysa), reconnect tetikleme.
         */
        if (activeConnectionIdRef.current !== myId) return;

        cleanupTimers();

        // Otomatik reconnect — aynı myId ile doConnect'i çağır
        reconnectTimeoutRef.current = setTimeout(() => {
          if (activeConnectionIdRef.current === myId) {
            doConnect();
          }
        }, RECONNECT_DELAY);
      };

      // ─── onerror ───
      socket.onerror = () => {
        // onclose zaten tetiklenecek, burada ek işlem gerekmez
      };
    }

    doConnect();

    return () => {
      /**
       * Unmount cleanup:
       * activeConnectionIdRef'i ARTIRIYORUZ (sıfırlamıyoruz!).
       * Bu sayede eski socket'in geç gelen onclose callback'i myId ile eşleşemez.
       *
       * Örnek: myId=3 iken unmount → activeRef=4
       * Eski onclose: activeRef(4) !== myId(3) → reconnect YAPILMAZ
       * Yeni mount: myId=5 → çakışma yok
       */
      activeConnectionIdRef.current++;

      // Tüm timer'ları temizle
      cleanupTimers();

      // WebSocket bağlantısını kapat
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return { sendTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate };
}
