/**
 * VoiceParticipant — Ses odasında tek bir katılımcı tile'ı.
 *
 * CSS class'ları:
 * - Tam mod: .voice-participant, .voice-participant-avatar, .voice-participant-avatar.speaking,
 *   .voice-participant-name, .voice-participant-overlay
 * - Kompakt mod: .voice-participant-compact (wrapper), aynı alt class'lar küçük boyutta
 *
 * İki boyut modu:
 * - Tam mod (compact=false): 64px avatar + isim altında — screen share yokken
 * - Kompakt mod (compact=true): 32px avatar + isim yanında — screen share strip'i
 *
 * Sağ tıklama:
 * - VoiceUserContextMenu açılır (volume slider, local mute, admin server mute/deafen)
 * - Kendi kullanıcımız için context menu açılmaz
 *
 * voiceStore.activeSpeakers üzerinden konuşma algılama yapılır
 * (VoiceStateManager tarafından güncellenir).
 * Katılımcının durumuna göre:
 * - Konuşuyorsa: yeşil ring animasyonu
 * - Mute ise: kırmızı mic-off icon overlay
 * - Deafen ise: kırmızı headphone-off icon overlay
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useIsSpeaking } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import VoiceUserContextMenu from "./VoiceUserContextMenu";
import { resolveAssetUrl } from "../../utils/constants";

type VoiceParticipantProps = {
  participant: Participant;
  /** Kompakt mod — screen share aktifken küçük gösterim */
  compact?: boolean;
};

/** Konuşma hold süresi (ms). useIsSpeaking heceler arası false döndüğünde
 *  bu süre kadar bekler — tekrar true gelirse timer iptal edilir.
 *  Discord ~250-350ms kullanır. 300ms doğal konuşmadaki mikro-sessizlikleri kapsar. */
const SPEAKING_HOLD_MS = 300;

function VoiceParticipant({ participant, compact = false }: VoiceParticipantProps) {
  // useIsSpeaking: LiveKit'in kendi hook'u.
  // LOCAL participant için → lokal AnalyserNode ile ses analizi (SFU'ya gitmez, anında tepki)
  // REMOTE participant için → SFU'dan gelen speaker bilgisi
  const rawSpeaking = useIsSpeaking(participant);

  // ─── Hold timer: yanıp sönmeyi önler ───
  // rawSpeaking true olunca anında isSpeaking=true set edilir.
  // rawSpeaking false olunca SPEAKING_HOLD_MS bekler — bu süre içinde tekrar
  // true gelirse timer iptal edilir ve isSpeaking true kalır.
  // Bu pattern Discord'un speaking indicator davranışını replike eder.
  const [isSpeaking, setIsSpeaking] = useState(false);
  const holdTimerRef = useRef<number>(0);

  useEffect(() => {
    if (rawSpeaking) {
      // Konuşma başladı — bekleyen "kapat" timer'ını iptal et, hemen göster
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = 0;
      }
      setIsSpeaking(true);
    } else {
      // Konuşma durdu — hold süresi kadar bekle, belki heceler arası sessizliktir
      if (!holdTimerRef.current) {
        holdTimerRef.current = window.setTimeout(() => {
          setIsSpeaking(false);
          holdTimerRef.current = 0;
        }, SPEAKING_HOLD_MS);
      }
    }

    return () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = 0;
      }
    };
  }, [rawSpeaking]);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // Bu katılımcının voice state'ini bul (mute/deafen bilgisi)
  const channelStates = currentVoiceChannelId
    ? voiceStates[currentVoiceChannelId] ?? []
    : [];
  const voiceState = channelStates.find(
    (s) => s.user_id === participant.identity
  );

  // Görünen isim: voiceState'teki display_name > LiveKit participant.name > username > identity
  const displayName =
    voiceState?.display_name || voiceState?.username || participant.name || participant.identity;
  const firstLetter = displayName.charAt(0).toUpperCase();
  const avatarUrl = voiceState?.avatar_url || "";
  const isMuted = voiceState?.is_muted ?? false;
  const isDeafened = voiceState?.is_deafened ?? false;

  // Kendi kendinin context menu'sünü açmak anlamsız — sadece remote katılımcılar
  const isLocalUser = participant.identity === currentUserId;

  const avatarClass = `voice-participant-avatar${isSpeaking ? " speaking" : ""}`;

  // ─── Context menu: sağ tık ile aç ───
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocalUser) return;

      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocalUser]
  );

  // Mute/Deafen overlay — her iki modda da gösterilir
  const overlay = (isMuted || isDeafened) ? (
    <div className="voice-participant-overlay">
      {isDeafened ? (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
        </svg>
      ) : (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
        </svg>
      )}
    </div>
  ) : null;

  // VoiceUserContextMenu — portal ile body'ye render edilir
  const contextMenu = ctxMenu ? (
    <VoiceUserContextMenu
      userId={participant.identity}
      username={voiceState?.username ?? participant.name ?? participant.identity}
      displayName={displayName}
      avatarUrl={avatarUrl}
      position={ctxMenu}
      onClose={() => setCtxMenu(null)}
    />
  ) : null;

  // Avatar içeriği — resim varsa img, yoksa ilk harf
  const avatarContent = avatarUrl ? (
    <img
      src={resolveAssetUrl(avatarUrl)}
      alt={displayName}
      style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
    />
  ) : (
    firstLetter
  );

  // ─── Kompakt mod: Screen share strip'inde küçük avatar + isim ───
  if (compact) {
    return (
      <>
        <div className="voice-participant-compact" onContextMenu={handleContextMenu}>
          <div className={avatarClass}>
            {avatarContent}
            {overlay}
          </div>
          <span className="voice-participant-name">{displayName}</span>
        </div>
        {contextMenu}
      </>
    );
  }

  // ─── Tam mod: Büyük avatar + isim altında ───
  return (
    <>
      <div className="voice-participant" onContextMenu={handleContextMenu}>
        <div className={avatarClass}>
          {avatarContent}
          {overlay}
        </div>
        <span className="voice-participant-name">{displayName}</span>
      </div>
      {contextMenu}
    </>
  );
}

export default VoiceParticipant;
