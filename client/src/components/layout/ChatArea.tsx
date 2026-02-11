/**
 * ChatArea — Orta panel: kanal başlığı + mesajlar VEYA voice room.
 *
 * Seçili kanalın tipine göre farklı içerik gösterir:
 * - text kanal: MessageList + TypingIndicator + MessageInput
 * - voice kanal + bağlı: VoiceRoom (LiveKit)
 * - voice kanal + bağlı değil: "Join Voice" mesajı
 *
 * Discord referans spacing'leri:
 * - Header: h-header(48px), hash/speaker + isim + divider + topic
 * - Messages: geniş padding, alt hizalı
 * - Input: rounded-lg, 44px yükseklik, generous padding
 */

import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import { useVoiceStore } from "../../stores/voiceStore";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";
import VoiceRoom from "../voice/VoiceRoom";

type ChatAreaProps = {
  sendTyping: (channelId: string) => void;
  onJoinVoice: (channelId: string) => Promise<void>;
};

function ChatArea({ sendTyping, onJoinVoice }: ChatAreaProps) {
  const { t } = useTranslation("chat");
  const { t: tVoice } = useTranslation("voice");
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const categories = useChannelStore((s) => s.categories);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);

  /** Seçili kanalın bilgilerini bul */
  const selectedChannel = categories
    .flatMap((cg) => cg.channels)
    .find((ch) => ch.id === selectedChannelId);

  const channelName = selectedChannel?.name ?? "";

  /** Voice kanala bakıyor ve bağlı mı? */
  const isViewingConnectedVoice =
    selectedChannel?.type === "voice" &&
    currentVoiceChannelId === selectedChannelId;

  /** Voice kanala bakıyor ama bağlı değil mi? */
  const isViewingDisconnectedVoice =
    selectedChannel?.type === "voice" &&
    currentVoiceChannelId !== selectedChannelId;

  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* ─── Channel Header ─── */}
      <div className="flex h-header shrink-0 items-center border-b border-background-tertiary px-4 shadow-sm">
        {selectedChannel ? (
          <>
            <div className="flex items-center gap-2.5">
              <span className="text-2xl leading-none text-text-muted">
                {selectedChannel.type === "text" ? "#" : (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M12 6a7 7 0 010 14M8.464 8.464a5 5 0 000 7.072" />
                  </svg>
                )}
              </span>
              <h3 className="text-[15px] font-semibold text-text-primary">{channelName}</h3>
            </div>

            {selectedChannel.topic && (
              <>
                <div className="mx-4 h-6 w-px bg-background-tertiary" />
                <p className="truncate text-sm text-text-muted">
                  {selectedChannel.topic}
                </p>
              </>
            )}
          </>
        ) : (
          <p className="text-sm text-text-muted">{t("channelStart", { channel: "" })}</p>
        )}
      </div>

      {/* ─── İçerik: Text / Voice Connected / Voice Disconnected ─── */}
      {isViewingConnectedVoice ? (
        // Voice kanala bakıyor VE bağlı → VoiceRoom (LiveKit)
        <VoiceRoom />
      ) : isViewingDisconnectedVoice ? (
        // Voice kanala bakıyor AMA bağlı değil → "Join Voice" mesajı
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <svg
            className="h-16 w-16 text-text-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.536 8.464a5 5 0 010 7.072M12 6a7 7 0 010 14M8.464 8.464a5 5 0 000 7.072M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"
            />
          </svg>
          <p className="text-sm text-text-muted">{tVoice("joinVoicePrompt")}</p>
          <button
            onClick={() => {
              if (selectedChannelId) {
                onJoinVoice(selectedChannelId);
              }
            }}
            className="rounded-md bg-brand px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
          >
            {tVoice("joinVoice")}
          </button>
        </div>
      ) : (
        // Normal text kanal (veya hiçbir kanal seçili değil)
        <>
          {/* ─── Messages Area ─── */}
          <MessageList />

          {/* ─── Typing Indicator ─── */}
          <TypingIndicator />

          {/* ─── Message Input ─── */}
          <MessageInput sendTyping={sendTyping} />
        </>
      )}
    </div>
  );
}

export default ChatArea;
