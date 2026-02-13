/**
 * VoicePopup — Floating, draggable sesli kanal paneli.
 *
 * CSS class'ları: .voice-popup, .vp-mini, .vp-bar, .vp-pulse,
 * .vp-bar-main, .vp-title, .vp-ch, .vp-btns, .vp-mini-icon,
 * .vp-mini-ring, .vp-body, .vp-controls, .vp-ctrl, .vp-ctrl.active,
 * .vp-end, .vp-users, .vp-user, .vp-user.speaking, .vp-uname, .vp-speak-dot
 *
 * Mini mode: .vp-mini class'ı eklenir, CSS body'yi gizler, bar'ı küçültür.
 * Drag: mousedown → mousemove ile pozisyon güncellenir.
 */

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useChannelStore } from "../../stores/channelStore";
import Avatar from "../shared/Avatar";

type VoicePopupProps = {
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
};

function VoicePopup({
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
}: VoicePopupProps) {
  const { t } = useTranslation("voice");
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const categories = useChannelStore((s) => s.categories);

  const [mini, setMini] = useState(false);
  const [visible, setVisible] = useState(true);
  const [pos, setPos] = useState<{ x: number | null; y: number }>({ x: null, y: 70 });
  const popRef = useRef<HTMLDivElement>(null);

  const channelName = currentVoiceChannelId
    ? categories.flatMap((cg) => cg.channels).find((ch) => ch.id === currentVoiceChannelId)?.name ?? ""
    : "";

  const participants = currentVoiceChannelId
    ? voiceStates[currentVoiceChannelId] ?? []
    : [];

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;

      if (mini) {
        setMini(false);
        return;
      }

      const rect = popRef.current?.getBoundingClientRect();
      if (!rect) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const startL = rect.left;
      const startT = rect.top;

      function onMove(ev: MouseEvent) {
        setPos({
          x: startL + ev.clientX - startX,
          y: startT + ev.clientY - startY,
        });
      }

      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [mini]
  );

  if (!currentVoiceChannelId) return null;
  if (!visible) return null;

  return (
    <div
      ref={popRef}
      className={`voice-popup${mini ? " vp-mini" : ""}`}
      style={{
        top: pos.y,
        ...(pos.x !== null ? { left: pos.x, right: "auto" } : { right: 20 }),
      }}
    >
      {/* ─── Bar (header) ─── */}
      <div className="vp-bar" onMouseDown={onMouseDown}>
        {/* Mini mode icon — CSS shows only in .vp-mini */}
        <div className="vp-mini-icon">
          {"\uD83D\uDD0A"}
          <span className="vp-mini-ring" />
        </div>

        {/* Main bar content — CSS hides in .vp-mini */}
        <div className="vp-bar-main">
          <span className="vp-pulse" />
          <span className="vp-title">{t("voiceConnected")}</span>
          <span className="vp-ch">{channelName}</span>
        </div>

        {/* Minimize / Close buttons */}
        <div className="vp-btns">
          <button onClick={() => setMini(!mini)}>─</button>
          <button onClick={() => setVisible(false)}>✕</button>
        </div>
      </div>

      {/* ─── Body (CSS hides in .vp-mini) ─── */}
      <div className="vp-body">
        {/* Controls */}
        <div className="vp-controls">
          <button
            className={`vp-ctrl${isMuted ? " active" : ""}`}
            onClick={onToggleMute}
            title={t("mute")}
          >
            {"\uD83C\uDFA4"}
          </button>
          <button
            className={`vp-ctrl${isDeafened ? " active" : ""}`}
            onClick={onToggleDeafen}
            title={t("deafen")}
          >
            {"\uD83C\uDFA7"}
          </button>
          <button
            className={`vp-ctrl${isStreaming ? " active" : ""}`}
            onClick={onToggleScreenShare}
            title={t("screenShare")}
          >
            {"\uD83D\uDDA5"}
          </button>
          <button
            className="vp-ctrl vp-end"
            onClick={onDisconnect}
            title={t("endCall")}
          >
            ✕
          </button>
        </div>

        {/* Participants */}
        <div className="vp-users">
          {participants.map((p) => (
            <div
              key={p.user_id}
              className={`vp-user${!p.is_muted ? " speaking" : ""}`}
            >
              <Avatar name={p.username} size={20} />
              <span className="vp-uname">{p.username}</span>
              {!p.is_muted && <span className="vp-speak-dot" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default VoicePopup;
