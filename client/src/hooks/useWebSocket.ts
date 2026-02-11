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
 */

import { useEffect, useRef, useCallback } from "react";
import { getAccessToken } from "../api/client";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import {
  WS_URL,
  WS_HEARTBEAT_INTERVAL,
  WS_HEARTBEAT_MAX_MISS,
} from "../utils/constants";
import type { WSMessage, Channel, Category, Message } from "../types";

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

  /** Component mount durumu — unmount sonrası reconnect engellenir */
  const isMountedRef = useRef<boolean>(true);

  /** Son typing gönderme zamanı: channelId → timestamp */
  const lastTypingRef = useRef<Map<string, number>>(new Map());

  // Store handler'larını al — referanslar her render'da güncel kalır
  const channelStore = useChannelStore;
  const messageStore = useMessageStore;

  /**
   * connect — WebSocket bağlantısı kurar.
   *
   * useCallback ile sarılır çünkü useEffect'in dependency'si olarak kullanılır.
   * Her render'da yeni fonksiyon oluşmasını önler.
   */
  const connect = useCallback(() => {
    const token = getAccessToken();
    if (!token || !isMountedRef.current) return;

    // Mevcut bağlantı varsa kapat
    if (wsRef.current) {
      wsRef.current.close();
    }

    const socket = new WebSocket(`${WS_URL}?token=${token}`);
    wsRef.current = socket;

    // ─── onopen ───
    socket.onopen = () => {
      missedHeartbeatsRef.current = 0;

      // Heartbeat interval başlat
      heartbeatIntervalRef.current = setInterval(() => {
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

      // Event routing — gelen event'i ilgili store handler'ına yönlendir
      routeEvent(msg);
    };

    // ─── onclose ───
    socket.onclose = () => {
      cleanup();

      // Otomatik reconnect — component hâlâ mount ise
      if (isMountedRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, RECONNECT_DELAY);
      }
    };

    // ─── onerror ───
    socket.onerror = () => {
      // onclose zaten tetiklenecek, burada ek işlem gerekmez
    };
  }, []);

  /**
   * routeEvent — Gelen WS event'ini op koduna göre ilgili store handler'ına yönlendirir.
   *
   * Bu fonksiyon WebSocket mesajlarının "switch/case" dağıtıcısıdır.
   * Her yeni event türü eklendiğinde buraya bir case eklenir.
   */
  function routeEvent(msg: WSMessage) {
    switch (msg.op) {
      // ─── Heartbeat ───
      case "heartbeat_ack":
        missedHeartbeatsRef.current = 0;
        break;

      // ─── Channel Events ───
      case "channel_create":
        channelStore.getState().handleChannelCreate(msg.d as Channel);
        break;
      case "channel_update":
        channelStore.getState().handleChannelUpdate(msg.d as Channel);
        break;
      case "channel_delete":
        channelStore.getState().handleChannelDelete((msg.d as { id: string }).id);
        break;

      // ─── Category Events ───
      case "category_create":
        channelStore.getState().handleCategoryCreate(msg.d as Category);
        break;
      case "category_update":
        channelStore.getState().handleCategoryUpdate(msg.d as Category);
        break;
      case "category_delete":
        channelStore.getState().handleCategoryDelete((msg.d as { id: string }).id);
        break;

      // ─── Message Events ───
      case "message_create":
        messageStore.getState().handleMessageCreate(msg.d as Message);
        break;
      case "message_update":
        messageStore.getState().handleMessageUpdate(msg.d as Message);
        break;
      case "message_delete":
        messageStore.getState().handleMessageDelete(
          msg.d as { id: string; channel_id: string }
        );
        break;

      // ─── Typing ───
      case "typing_start": {
        const data = msg.d as { channel_id: string; username: string };
        messageStore.getState().handleTypingStart(data.channel_id, data.username);
        break;
      }
    }
  }

  /** cleanup — Interval ve timeout'ları temizler */
  function cleanup() {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
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

  // ─── Effect: Mount/unmount lifecycle ───
  useEffect(() => {
    isMountedRef.current = true;
    connect();

    return () => {
      isMountedRef.current = false;

      // Tüm timer'ları temizle
      cleanup();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      // WebSocket bağlantısını kapat
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { sendTyping };
}
