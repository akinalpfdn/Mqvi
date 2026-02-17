/**
 * VoiceParticipant — Ses odasında tek bir katılımcı tile'ı.
 *
 * CSS class'ları:
 * - Tam mod: .voice-participant, .voice-participant-avatar, .voice-participant-avatar.speaking,
 *   .voice-participant-name, .voice-participant-overlay
 * - Kompakt mod: .voice-participant-compact (wrapper), aynı alt class'lar küçük boyutta
 * - Volume popup: .vp-vol-popup, .vp-vol-header, .vp-vol-slider, .vp-vol-value
 *
 * İki boyut modu:
 * - Tam mod (compact=false): 64px avatar + isim altında — screen share yokken
 * - Kompakt mod (compact=true): 32px avatar + isim yanında — screen share strip'i
 *
 * Per-user volume:
 * - Sağ tıklama ile volume slider popup açılır (0-200%)
 * - voiceStore.userVolumes üzerinden persist edilir
 * - VoiceStateManager bu değeri LiveKit RemoteParticipant.setVolume()'a iletir
 *
 * LiveKit'in useIsSpeaking hook'u ile konuşma algılama yapılır.
 * Katılımcının durumuna göre:
 * - Konuşuyorsa: yeşil ring animasyonu
 * - Mute ise: kırmızı mic-off icon overlay
 * - Deafen ise: kırmızı headphone-off icon overlay
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { useIsSpeaking } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";

type VoiceParticipantProps = {
  participant: Participant;
  /** Kompakt mod — screen share aktifken küçük gösterim */
  compact?: boolean;
};

function VoiceParticipant({ participant, compact = false }: VoiceParticipantProps) {
  const isSpeaking = useIsSpeaking(participant);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Volume popup state
  const [showVolume, setShowVolume] = useState(false);
  const [popupPos, setPopupPos] = useState({ x: 0, y: 0 });
  const popupRef = useRef<HTMLDivElement>(null);

  // Bu katılımcının voice state'ini bul (mute/deafen bilgisi)
  const channelStates = currentVoiceChannelId
    ? voiceStates[currentVoiceChannelId] ?? []
    : [];
  const voiceState = channelStates.find(
    (s) => s.user_id === participant.identity
  );

  const displayName = participant.name || participant.identity;
  const firstLetter = displayName.charAt(0).toUpperCase();
  const isMuted = voiceState?.is_muted ?? false;
  const isDeafened = voiceState?.is_deafened ?? false;

  // Kendi kendinin volume'unu ayarlamak anlamsız — sadece remote katılımcılar
  const isLocalUser = participant.identity === currentUserId;
  const currentVolume = userVolumes[participant.identity] ?? 100;

  const avatarClass = `voice-participant-avatar${isSpeaking ? " speaking" : ""}`;

  // ─── Volume popup: sağ tık ile aç ───
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Kendi katılımcımız için volume popup açma
      if (isLocalUser) return;

      e.preventDefault();
      setPopupPos({ x: e.clientX, y: e.clientY });
      setShowVolume(true);
    },
    [isLocalUser]
  );

  // Popup dışına tıklama ile kapat
  useEffect(() => {
    if (!showVolume) return;

    function handleClickOutside(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setShowVolume(false);
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setShowVolume(false);
    }

    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showVolume]);

  // Popup pozisyon düzeltme — ekranın dışına taşmayı önle
  useEffect(() => {
    if (!showVolume || !popupRef.current) return;

    const popup = popupRef.current;
    const rect = popup.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let adjustedX = popupPos.x;
    let adjustedY = popupPos.y;

    if (adjustedX + rect.width > viewportW - 8) {
      adjustedX = viewportW - rect.width - 8;
    }
    if (adjustedY + rect.height > viewportH - 8) {
      adjustedY = viewportH - rect.height - 8;
    }

    popup.style.left = `${adjustedX}px`;
    popup.style.top = `${adjustedY}px`;
  }, [showVolume, popupPos]);

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setUserVolume(participant.identity, Number(e.target.value));
    },
    [participant.identity, setUserVolume]
  );

  // Mute/Deafen overlay — her iki modda da gösterilir
  const overlay = (isMuted || isDeafened) ? (
    <div className="voice-participant-overlay">
      {isDeafened ? (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728A9 9 0 015.636 5.636" />
        </svg>
      ) : (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
        </svg>
      )}
    </div>
  ) : null;

  // ─── Volume popup (portal-free — voice room overflow: visible) ───
  const volumePopup = showVolume ? (
    <div
      ref={popupRef}
      className="vp-vol-popup"
      style={{ position: "fixed", left: popupPos.x, top: popupPos.y, zIndex: 9999 }}
    >
      <div className="vp-vol-header">{displayName}</div>
      <div className="vp-vol-slider">
        <svg style={{ width: 14, height: 14, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
        <input
          type="range"
          min={0}
          max={200}
          value={currentVolume}
          onChange={handleVolumeChange}
          className="vp-vol-range"
          style={{
            background: `linear-gradient(to right, var(--primary) ${(currentVolume / 200) * 100}%, var(--bg-5) ${(currentVolume / 200) * 100}%)`,
          }}
        />
        <span className="vp-vol-value">{currentVolume}%</span>
      </div>
    </div>
  ) : null;

  // ─── Kompakt mod: Screen share strip'inde küçük avatar + isim ───
  if (compact) {
    return (
      <>
        <div className="voice-participant-compact" onContextMenu={handleContextMenu}>
          <div className={avatarClass}>
            {firstLetter}
            {overlay}
          </div>
          <span className="voice-participant-name">{displayName}</span>
        </div>
        {volumePopup}
      </>
    );
  }

  // ─── Tam mod: Büyük avatar + isim altında ───
  return (
    <>
      <div className="voice-participant" onContextMenu={handleContextMenu}>
        <div className={avatarClass}>
          {firstLetter}
          {overlay}
        </div>
        <span className="voice-participant-name">{displayName}</span>
      </div>
      {volumePopup}
    </>
  );
}

export default VoiceParticipant;
