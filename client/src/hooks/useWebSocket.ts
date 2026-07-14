/**
 * useWebSocket — WebSocket connection and event routing hook.
 *
 * Singleton — only used in AppLayout.tsx.
 * Responsibilities:
 * 1. Establish WS connection on login
 * 2. Send heartbeats (30s interval, 3 misses = disconnect)
 * 3. Route incoming events to store handlers (switch/case)
 * 4. Auto-reconnect on disconnect (exponential backoff, never gives up)
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
import { useVoiceStore } from "../stores/voiceStore";
import {
  WS_URL,
  WS_HEARTBEAT_INTERVAL,
  WS_HEARTBEAT_PROBE_INTERVAL,
  WS_HEARTBEAT_MAX_MISS,
  WS_MAX_RECONNECT_ATTEMPTS,
} from "../utils/constants";
import type { WSMessage, UserStatus } from "../types";
import { handleChannelEvent } from "./ws/channelEventHandlers";
import { handleDMEvent } from "./ws/dmEventHandlers";
import { handleVoiceEvent } from "./ws/voiceEventHandlers";
import { handleSystemEvent } from "./ws/systemEventHandlers";
import { getDeviceId } from "../utils/deviceId";
import type { WSHandlerContext } from "./ws/types";

/**
 * Exponential backoff reconnect schedule (ms).
 * Fast first attempt catches brief network blips before the server-side
 * orphan grace period (35s) expires. Later attempts back off to avoid
 * thundering herd during server outages.
 */
const RECONNECT_BASE_DELAY = 1_500;
const RECONNECT_MAX_DELAY = 20_000;

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
   * Set once the attempt budget runs out. Retries continue, but the banner stays on
   * "disconnected" until a `ready` arrives — otherwise it would flash red→yellow→red
   * on every capped retry.
   */
  const exhaustedRef = useRef<boolean>(false);

  /** Set while the post-resume probe interval is active (see startHeartbeatRef). */
  const heartbeatProbingRef = useRef<boolean>(false);

  /** Restarts the heartbeat interval at the given period. Assigned inside the connect effect. */
  const startHeartbeatRef = useRef<((intervalMs: number) => void) | null>(null);

  /**
   * Monotonically increasing connection ID — StrictMode guard.
   * Never reset to 0; always incremented to keep IDs unique.
   */
  const activeConnectionIdRef = useRef<number>(0);

  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "connecting" | "disconnected"
  >("connecting");

  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

  /** Clears the exhausted latch once the session is live again, so the next blip shows yellow. */
  const updateStatus = useCallback((status: "connected" | "connecting" | "disconnected") => {
    if (status === "connected") exhaustedRef.current = false;
    setConnectionStatus(status);
  }, []);

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
      // Only an ack to a beat we sent proves the socket is alive. An ack buffered by the OS
      // before the app froze arrives with no beat outstanding and must not cancel the probe.
      const answeredOutstandingBeat = heartbeatProbingRef.current && missedHeartbeatsRef.current > 0;
      missedHeartbeatsRef.current = 0;

      if (answeredOutstandingBeat) {
        heartbeatProbingRef.current = false;
        startHeartbeatRef.current?.(WS_HEARTBEAT_INTERVAL);
      }
      return;
    }

    const ctx: WSHandlerContext = { sendVoiceJoin };

    if (await handleChannelEvent(msg)) return;
    if (await handleDMEvent(msg)) return;
    if (await handleVoiceEvent(msg, ctx)) return;
    if (await handleSystemEvent(msg, ctx, updateStatus)) return;
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

  /**
   * Exponential backoff with jitter. Attempt 1 ≈ 1.5s, then 3s, 6s, ...
   * Jitter (±25%) prevents synchronized reconnects after server restart.
   * 7 attempts covers ~60s total — well beyond the 35s orphan grace period.
   */
  function getReconnectDelay(): number {
    const attempt = reconnectAttemptRef.current;
    const base = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt), RECONNECT_MAX_DELAY);
    const jitter = base * 0.25 * (Math.random() * 2 - 1); // ±25%
    return Math.round(base + jitter);
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
      const { isMuted, isDeafened } = useVoiceStore.getState();
      wsRef.current.send(
        JSON.stringify({
          op: "voice_join",
          d: { channel_id: channelId, is_muted: isMuted, is_deafened: isDeafened },
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
     * (Re)starts the heartbeat at the given period. A socket that misses
     * WS_HEARTBEAT_MAX_MISS acks closes itself — the single close path, shared by the
     * steady-state interval and the post-resume probe. Reads wsRef at tick time so it
     * never holds a stale socket.
     */
    function startHeartbeat(intervalMs: number) {
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);

      heartbeatIntervalRef.current = setInterval(() => {
        const socket = wsRef.current;
        if (activeConnectionIdRef.current !== myId || !socket) {
          if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
          return;
        }

        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: "heartbeat" }));
          missedHeartbeatsRef.current++;

          if (missedHeartbeatsRef.current >= WS_HEARTBEAT_MAX_MISS) {
            socket.close();
          }
        }
      }, intervalMs);
    }

    startHeartbeatRef.current = startHeartbeat;

    /**
     * scheduleReconnect — Exponential backoff. After the attempt budget runs out the
     * banner reports failure, but retries keep going at RECONNECT_MAX_DELAY: on mobile a
     * tunnel easily outlasts the budget, and the banner's only manual escape is a full
     * page reload that would also tear down an active LiveKit session.
     */
    function scheduleReconnect() {
      if (activeConnectionIdRef.current !== myId) return;

      const delay = getReconnectDelay();

      if (reconnectAttemptRef.current >= WS_MAX_RECONNECT_ATTEMPTS) {
        exhaustedRef.current = true;
        updateStatus("disconnected");
      } else {
        reconnectAttemptRef.current++;
        setReconnectAttempt(reconnectAttemptRef.current);
      }

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

      // Once exhausted the banner stays red until `ready` — a capped retry every 20s
      // must not flip it back to "connecting".
      if (!exhaustedRef.current) updateStatus("connecting");

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

      let socket: WebSocket;
      try {
        // device_id lets the server address ONE of the user's devices — so it can skip the one
        // that just answered a call when it tells the rest to stop ringing.
        socket = new WebSocket(
          `${WS_URL}?token=${token}&device_id=${encodeURIComponent(getDeviceId())}`,
        );
      } catch (err) {
        // A malformed WS_URL throws synchronously. Without this the hook would sit on
        // "connecting" forever, since no socket exists to fire onclose.
        console.warn("[useWebSocket] failed to open socket", err);
        scheduleReconnect();
        return;
      }
      wsRef.current = socket;

      // ─── onopen ───
      socket.onopen = () => {
        if (activeConnectionIdRef.current !== myId || wsRef.current !== socket) return;

        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        missedHeartbeatsRef.current = 0;
        heartbeatProbingRef.current = false;

        startHeartbeat(WS_HEARTBEAT_INTERVAL);

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
        if (activeConnectionIdRef.current !== myId || wsRef.current !== socket) return;

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
      socket.onclose = (event: CloseEvent) => {
        // Stale socket guard — critical for StrictMode
        if (activeConnectionIdRef.current !== myId) return;
        // A socket we already replaced still fires onclose. Without this it would clear the
        // live socket's timers and schedule a reconnect that kills the healthy connection.
        if (wsRef.current !== socket) return;

        console.warn(`[useWebSocket] socket closed: code=${event.code} reason=${event.reason || "-"}`);

        // A close is the start of a reconnect, not a failure — scheduleReconnect owns the
        // decision to report failure once the attempt budget is spent.
        if (!exhaustedRef.current) updateStatus("connecting");
        cleanupTimers();
        scheduleReconnect();
      };

      // ─── onerror ───
      socket.onerror = () => {
        // onclose will fire — no additional handling needed
      };
    }

    doConnect();

    // App resume listener — mobile background → foreground
    function onAppResume() {
      if (activeConnectionIdRef.current !== myId) return;

      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        exhaustedRef.current = false;
        doConnect();
        return;
      }

      // OPEN is not proof of life: the server drops us after pongWait (90s) while the
      // WebView's timers are frozen, and a half-open socket never reports the FIN. Probe
      // at a shorter period so a dead socket is detected in 3 × 10s instead of 3 × 30s.
      if (ws.readyState === WebSocket.OPEN) {
        missedHeartbeatsRef.current = 0;
        heartbeatProbingRef.current = true;
        startHeartbeat(WS_HEARTBEAT_PROBE_INTERVAL);
      }
    }

    window.addEventListener(APP_RESUME_EVENT, onAppResume);

    return () => {
      // Increment (not reset) to invalidate all callbacks from this connection
      activeConnectionIdRef.current++;
      cleanupTimers();
      startHeartbeatRef.current = null;
      heartbeatProbingRef.current = false;
      window.removeEventListener(APP_RESUME_EVENT, onAppResume);

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return { sendTyping, sendDMTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate, sendWS, connectionStatus, reconnectAttempt };
}
