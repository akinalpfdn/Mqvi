/**
 * useWebSocket — WebSocket connection and event routing hook.
 *
 * Singleton — only used in AppLayout.tsx.
 * Responsibilities:
 * 1. Establish WS connection on login
 * 2. Send heartbeats (30s interval, 3 misses = disconnect)
 * 3. Route incoming events to store handlers (switch/case)
 * 4. Auto-reconnect on disconnect (10s delay, max 5 attempts)
 * 5. Expose sendTyping for MessageInput
 *
 * StrictMode protection:
 * Each effect invocation gets a monotonically increasing connectionId.
 * Socket callbacks only execute if their connectionId is still active.
 * IDs are incremented (never reset) to prevent stale onclose collisions.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { ensureFreshToken } from "../api/client";
import { APP_RESUME_EVENT } from "../utils/nativePlugins";
import { useP2PCallStore } from "../stores/p2pCallStore";
import {
  WS_URL,
  WS_HEARTBEAT_INTERVAL,
  WS_HEARTBEAT_MAX_MISS,
} from "../utils/constants";
import type { WSMessage, UserStatus } from "../types";
import { handleChannelEvent } from "./ws/channelEventHandlers";
import { handleDMEvent } from "./ws/dmEventHandlers";
import { handleVoiceEvent } from "./ws/voiceEventHandlers";
import { handleSystemEvent } from "./ws/systemEventHandlers";
import type { WSHandlerContext } from "./ws/types";

/** Fixed reconnect delay (ms) */
const RECONNECT_DELAY = 10_000;

/** Max reconnect attempts before showing "disconnected" */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Typing throttle (ms) — prevents flooding same channel */
const TYPING_THROTTLE = 3_000;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef<number>(0);
  const missedHeartbeatsRef = useRef<number>(0);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef<number>(0);

  /**
   * Monotonically increasing connection ID — StrictMode guard.
   * Never reset to 0; always incremented to keep IDs unique.
   */
  const activeConnectionIdRef = useRef<number>(0);

  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "connecting" | "disconnected"
  >("connecting");

  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

  /** Last typing timestamp per channel — throttle map */
  const lastTypingRef = useRef<Map<string, number>>(new Map());

  /**
   * routeEventRef — "latest ref" pattern.
   * Updated every render so onmessage always calls the freshest handler,
   * avoiding stale closures after HMR or re-renders.
   */
  const routeEventRef = useRef<(msg: WSMessage) => void>(() => {});

  /**
   * routeEvent — Thin dispatcher that delegates to domain-specific handler modules.
   * Each handler returns true if it handled the event, false otherwise.
   */
  async function routeEvent(msg: WSMessage) {
    // Heartbeat ack is handled inline (no store interaction)
    if (msg.op === "heartbeat_ack") {
      missedHeartbeatsRef.current = 0;
      return;
    }

    const ctx: WSHandlerContext = { sendVoiceJoin };

    if (await handleChannelEvent(msg)) return;
    if (await handleDMEvent(msg)) return;
    if (await handleVoiceEvent(msg, ctx)) return;
    if (await handleSystemEvent(msg, ctx, setConnectionStatus)) return;
  }

  // Keep routeEventRef fresh every render (latest ref pattern)
  routeEventRef.current = routeEvent;

  function cleanupTimers() {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (tokenRefreshIntervalRef.current) {
      clearInterval(tokenRefreshIntervalRef.current);
      tokenRefreshIntervalRef.current = null;
    }
  }

  /** Fixed 10s reconnect delay. 5 attempts x 10s = 50s before giving up. */
  function getReconnectDelay(): number {
    return RECONNECT_DELAY;
  }

  /**
   * sendTyping — Called by MessageInput on keystroke.
   * Throttled: max once per 3s per channel.
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

  /** sendDMTyping — Same throttle as channel typing. */
  const sendDMTyping = useCallback((dmChannelId: string) => {
    const now = Date.now();
    const key = `dm:${dmChannelId}`;
    const lastSent = lastTypingRef.current.get(key) ?? 0;

    if (now - lastSent < TYPING_THROTTLE) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "dm_typing_start",
          d: { dm_channel_id: dmChannelId },
        })
      );
      lastTypingRef.current.set(key, now);
    }
  }, []);

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
   * sendPresenceUpdate — Sends presence status via WS.
   * Called by idle detection (isAuto=true) and manual status picker (isAuto=false).
   * Auto-idle does NOT persist to pref_status — so idle detection resumes after WS reconnect.
   */
  const sendPresenceUpdate = useCallback((status: UserStatus, isAuto = false) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "presence_update",
          d: { status, is_auto: isAuto },
        })
      );
    }
  }, []);

  /** sendVoiceStateUpdate — Partial update: only changed fields are sent. */
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

  /**
   * sendWS — Generic WS sender, used by P2P call store.
   * Single function instead of per-event helpers since store knows its own op codes.
   */
  const sendWS = useCallback((op: string, data?: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ op, d: data })
      );
    }
  }, []);

  // Register WS sender in P2P call store
  useP2PCallStore.getState().registerSendWS(sendWS);

  // ─── Effect: Mount/unmount lifecycle ───
  useEffect(() => {
    const myId = ++activeConnectionIdRef.current;

    /**
     * scheduleReconnect — Fixed 10s delay, max 5 attempts.
     * Shows "disconnected" banner after limit is reached.
     */
    function scheduleReconnect() {
      if (activeConnectionIdRef.current !== myId) return;

      if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setConnectionStatus("disconnected");
        return;
      }

      const delay = getReconnectDelay();
      reconnectAttemptRef.current++;
      setReconnectAttempt(reconnectAttemptRef.current);

      reconnectTimeoutRef.current = setTimeout(() => {
        if (activeConnectionIdRef.current === myId) {
          doConnect();
        }
      }, delay);
    }

    /**
     * doConnect — Establishes WS connection within this effect scope.
     * Refreshes token before connecting (WS has no 401 retry mechanism).
     */
    async function doConnect() {
      if (activeConnectionIdRef.current !== myId) return;

      setConnectionStatus("connecting");

      let token: string | null = null;
      try {
        token = await ensureFreshToken();
      } catch {
        // Server may be down — network error on refresh
      }

      if (activeConnectionIdRef.current !== myId) return;

      if (!token) {
        scheduleReconnect();
        return;
      }

      cleanupTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const socket = new WebSocket(`${WS_URL}?token=${token}`);
      wsRef.current = socket;

      // ─── onopen ───
      socket.onopen = () => {
        if (activeConnectionIdRef.current !== myId) return;

        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        missedHeartbeatsRef.current = 0;

        // Start heartbeat interval
        heartbeatIntervalRef.current = setInterval(() => {
          if (activeConnectionIdRef.current !== myId) {
            clearInterval(heartbeatIntervalRef.current!);
            return;
          }

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "heartbeat" }));
            missedHeartbeatsRef.current++;

            if (missedHeartbeatsRef.current >= WS_HEARTBEAT_MAX_MISS) {
              socket.close();
            }
          }
        }, WS_HEARTBEAT_INTERVAL);

        // Proactive token refresh every 10min while WS is open.
        // Access token expires at 15min — 10min gives 5min buffer.
        // On failure, retries every 10s (up to 9 times) for smooth recovery.
        const TOKEN_REFRESH_INTERVAL = 10 * 60 * 1000;
        const TOKEN_REFRESH_RETRY_DELAY = 10_000;
        const TOKEN_REFRESH_MAX_RETRIES = 9;

        tokenRefreshIntervalRef.current = setInterval(async () => {
          if (activeConnectionIdRef.current !== myId) {
            clearInterval(tokenRefreshIntervalRef.current!);
            return;
          }

          for (let attempt = 0; attempt < TOKEN_REFRESH_MAX_RETRIES; attempt++) {
            try {
              await ensureFreshToken();
              break;
            } catch {
              console.warn(`[useWebSocket] Token refresh attempt ${attempt + 1} failed`);
              if (attempt < TOKEN_REFRESH_MAX_RETRIES - 1) {
                await new Promise((r) => setTimeout(r, TOKEN_REFRESH_RETRY_DELAY));
                if (activeConnectionIdRef.current !== myId) return;
              }
            }
          }
        }, TOKEN_REFRESH_INTERVAL);
      };

      // ─── onmessage ───
      socket.onmessage = (event: MessageEvent) => {
        if (activeConnectionIdRef.current !== myId) return;

        let msg: WSMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (msg.seq) {
          lastSeqRef.current = msg.seq;
        }

        // Route via ref for closure freshness
        routeEventRef.current(msg);
      };

      // ─── onclose ───
      socket.onclose = () => {
        // Stale socket guard — critical for StrictMode
        if (activeConnectionIdRef.current !== myId) return;

        setConnectionStatus("disconnected");
        cleanupTimers();
        scheduleReconnect();
      };

      // ─── onerror ───
      socket.onerror = () => {
        // onclose will fire — no additional handling needed
      };
    }

    doConnect();

    // App resume listener — reconnect WS if socket is closed (mobile background → foreground)
    function onAppResume() {
      if (activeConnectionIdRef.current !== myId) return;

      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        doConnect();
      }
    }

    window.addEventListener(APP_RESUME_EVENT, onAppResume);

    return () => {
      // Increment (not reset) to invalidate all callbacks from this connection
      activeConnectionIdRef.current++;
      cleanupTimers();
      window.removeEventListener(APP_RESUME_EVENT, onAppResume);

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return { sendTyping, sendDMTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate, sendWS, connectionStatus, reconnectAttempt };
}
