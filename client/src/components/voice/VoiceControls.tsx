/**
 * VoiceControls — Sidebar'da ChannelList ile UserBar arasına yerleşen kontrol paneli.
 *
 * Sadece kullanıcı bir ses kanalına bağlıyken görünür.
 * Discord referans: Sidebar'ın altındaki yeşil "Voice Connected" paneli.
 *
 * İçerik:
 * - Yeşil "Voice Connected" göstergesi + kanal adı
 * - Mute butonu (mikrofon aç/kapa)
 * - Deafen butonu (ses çıkışı aç/kapa)
 * - Disconnect butonu (kırmızı telefon icon'u)
 */

import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useChannelStore } from "../../stores/channelStore";

type VoiceControlsProps = {
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
};

function VoiceControls({
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
}: VoiceControlsProps) {
  const { t } = useTranslation("voice");
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const categories = useChannelStore((s) => s.categories);

  // Ses kanalına bağlı değilse gösterme
  if (!currentVoiceChannelId) return null;

  // Kanal adını bul
  const channelName = categories
    .flatMap((cg) => cg.channels)
    .find((ch) => ch.id === currentVoiceChannelId)?.name;

  return (
    <div className="border-t border-background-tertiary bg-background-floating/40 px-2 py-2">
      {/* Bağlantı göstergesi */}
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <span className="h-2 w-2 shrink-0 rounded-full bg-status-online" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-status-online">
            {t("voiceConnected")}
          </p>
          {channelName && (
            <p className="truncate text-[11px] text-text-muted">
              {channelName}
            </p>
          )}
        </div>
      </div>

      {/* Kontrol butonları */}
      <div className="flex items-center gap-1">
        {/* Mute butonu */}
        <button
          onClick={onToggleMute}
          title={isMuted ? t("unmute") : t("mute")}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            isMuted
              ? "bg-danger/20 text-danger hover:bg-danger/30"
              : "text-text-muted hover:bg-surface-hover hover:text-text-primary"
          }`}
        >
          {isMuted ? (
            // Mic off
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
            </svg>
          ) : (
            // Mic on
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          )}
        </button>

        {/* Deafen butonu */}
        <button
          onClick={onToggleDeafen}
          title={isDeafened ? t("undeafen") : t("deafen")}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            isDeafened
              ? "bg-danger/20 text-danger hover:bg-danger/30"
              : "text-text-muted hover:bg-surface-hover hover:text-text-primary"
          }`}
        >
          {isDeafened ? (
            // Headphone off
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728A9 9 0 015.636 5.636" />
            </svg>
          ) : (
            // Headphone on
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
            </svg>
          )}
        </button>

        {/* Screen share butonu */}
        <button
          onClick={onToggleScreenShare}
          title={isStreaming ? t("stopScreenShare") : t("screenShare")}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            isStreaming
              ? "bg-brand/20 text-brand hover:bg-brand/30"
              : "text-text-muted hover:bg-surface-hover hover:text-text-primary"
          }`}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Disconnect butonu */}
        <button
          onClick={onDisconnect}
          title={t("leaveVoice")}
          className="flex h-8 w-8 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/20"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default VoiceControls;
