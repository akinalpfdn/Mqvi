/**
 * useP2PCall — P2P arama lifecycle yönetimi hook'u.
 *
 * Bu hook AppLayout seviyesinde MOUNT EDİLMELİDİR (useWebSocket gibi singleton).
 * Görevi:
 * 1. P2P call store'daki state değişikliklerini izler
 * 2. acceptCall geldiğinde WebRTC negotiation başlatır
 * 3. Caller/receiver rolünü belirler (useAuthStore.user.id ile)
 * 4. Voice channel çakışmasını yönetir (P2P arama başlarsa voice'tan çık)
 * 5. Arama başladığında UI tab açar
 * 6. Incoming call timeout (30sn) yönetir
 *
 * Neden ayrı hook?
 * Store sadece state tutar — React lifecycle (useEffect, cleanup) gerektiren
 * işlemler hook'ta yapılır. Bu pattern voiceStore + useVoice ile aynıdır.
 */

import { useEffect, useRef } from "react";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useUIStore } from "../stores/uiStore";

/** Gelen arama timeout süresi (ms) — 30 saniye sonra otomatik decline */
const INCOMING_CALL_TIMEOUT = 30_000;

/**
 * useP2PCall — P2P call lifecycle hook'u.
 *
 * AppLayout'ta bir kez çağrılır (singleton pattern).
 * Store'daki state değişikliklerini izler ve yan etkileri tetikler.
 */
export function useP2PCall() {
  /** Gelen arama timeout ref'i */
  const incomingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Önceki activeCall state'i — değişim algılamak için */
  const prevActiveCallRef = useRef<string | null>(null);

  // ─── Effect: Arama kabul edildiğinde WebRTC başlat ───
  useEffect(() => {
    /**
     * p2pCallStore.subscribe — Zustand store değişikliklerini dinler.
     *
     * subscribe nedir?
     * Zustand store'ları React dışından da dinlenebilir.
     * subscribe(callback) her state değişiminde callback'i çağırır.
     * Burada bunu kullanıyoruz çünkü WebRTC başlatma asenkron bir işlem —
     * useEffect deps ile yapılsa stale closure riski artar.
     */
    const unsubscribe = useP2PCallStore.subscribe((state, prev) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;

      // Arama accepted durumuna geçti mi?
      if (
        state.activeCall?.status === "active" &&
        prev.activeCall?.status === "ringing"
      ) {
        // Caller mı receiver mı belirle
        const isCaller = state.activeCall.caller_id === userId;

        // Voice channel'da isek çık (P2P ve voice channel çakışması)
        const voiceState = useVoiceStore.getState();
        if (voiceState.currentVoiceChannelId && voiceState._onLeaveCallback) {
          voiceState._onLeaveCallback();
        }

        // WebRTC başlat
        state.startWebRTC(isCaller);
      }
    });

    return () => unsubscribe();
  }, []);

  // ─── Effect: activeCall değiştiğinde UI tab aç ───
  useEffect(() => {
    const unsubscribe = useP2PCallStore.subscribe((state) => {
      const call = state.activeCall;
      const prevId = prevActiveCallRef.current;

      if (call && call.id !== prevId) {
        prevActiveCallRef.current = call.id;

        // P2P call tab'ı aç
        const userId = useAuthStore.getState().user?.id;
        const otherUser =
          call.caller_id === userId
            ? call.receiver_display_name ?? call.receiver_username
            : call.caller_display_name ?? call.caller_username;

        useUIStore.getState().openTab(call.id, "p2p", otherUser);
      } else if (!call && prevId) {
        prevActiveCallRef.current = null;
        // Arama bitti — p2p tab'ını kapat
        // Tab'ın channelId'si call.id idi, onu bulmamız lazım
        // closeTab panelId + tabId istiyor — tüm panelleri tarayalım
        const panels = useUIStore.getState().panels;
        for (const [panelId, panel] of Object.entries(panels)) {
          const tab = panel.tabs.find((t) => t.type === "p2p");
          if (tab) {
            useUIStore.getState().closeTab(panelId, tab.id);
            break;
          }
        }
      }
    });

    return () => unsubscribe();
  }, []);

  // ─── Effect: Incoming call timeout (30sn) ───
  useEffect(() => {
    const unsubscribe = useP2PCallStore.subscribe((state, prev) => {
      // Yeni gelen arama
      if (state.incomingCall && !prev.incomingCall) {
        // Eski timeout varsa temizle
        if (incomingTimeoutRef.current) {
          clearTimeout(incomingTimeoutRef.current);
        }

        // 30sn timeout başlat
        incomingTimeoutRef.current = setTimeout(() => {
          const current = useP2PCallStore.getState();
          if (current.incomingCall) {
            current.declineCall(current.incomingCall.id);
          }
        }, INCOMING_CALL_TIMEOUT);
      }

      // Gelen arama yanıtlandı/kapandı — timeout temizle
      if (!state.incomingCall && prev.incomingCall) {
        if (incomingTimeoutRef.current) {
          clearTimeout(incomingTimeoutRef.current);
          incomingTimeoutRef.current = null;
        }
      }
    });

    return () => {
      unsubscribe();
      if (incomingTimeoutRef.current) {
        clearTimeout(incomingTimeoutRef.current);
      }
    };
  }, []);

  // ─── Effect: handleCallInitiate'de caller/receiver ayrımı ───
  //
  // Store'daki handleCallInitiate hem activeCall hem incomingCall set eder.
  // Burada subscribe ile caller mı receiver mı olduğumuza göre düzeltiriz.
  useEffect(() => {
    const unsubscribe = useP2PCallStore.subscribe((state, prev) => {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;

      // Yeni arama initiate edildi
      if (state.activeCall && !prev.activeCall && state.activeCall.status === "ringing") {
        const call = state.activeCall;

        if (call.caller_id === userId) {
          // Biz caller'ız → activeCall kalır, incomingCall temizle
          useP2PCallStore.setState({ incomingCall: null });
        } else {
          // Biz receiver'ız → incomingCall kalır, activeCall olarak da tut
          // (kabul edince activeCall active'e döner)
        }
      }
    });

    return () => unsubscribe();
  }, []);
}
