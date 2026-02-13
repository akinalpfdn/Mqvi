/**
 * ChatArea — Text kanal görünümü: kanal başlığı + mesajlar + input.
 *
 * CSS class'ları: .chat-area, .channel-bar, .ch-hash, .ch-name,
 * .ch-divider, .ch-topic, .ch-actions
 *
 * Gradient overlay: .chat-area::after ile CSS'te tanımlıdır —
 * ayrı bir DOM element gerekmez. Typing ve input alanları
 * z-index:2 ile overlay'in üstünde kalır.
 */

import { useTranslation } from "react-i18next";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useUIStore } from "../../stores/uiStore";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";
import type { Channel } from "../../types";

type ChatAreaProps = {
  channelId: string;
  channel: Channel | null;
};

function ChatArea({ channelId, channel }: ChatAreaProps) {
  const { t } = useTranslation("chat");
  const { sendTyping } = useWebSocket();
  const toggleMembers = useUIStore((s) => s.toggleMembers);
  const membersOpen = useUIStore((s) => s.membersOpen);

  return (
    <div className="chat-area">
      {/* ─── Channel Bar (32px) ─── */}
      <div className="channel-bar">
        {channel ? (
          <>
            <span className="ch-hash">#</span>
            <span className="ch-name">{channel.name}</span>
            {channel.topic && (
              <>
                <div className="ch-divider" />
                <span className="ch-topic">{channel.topic}</span>
              </>
            )}
            <div className="ch-actions">
              <button
                className={membersOpen ? "active" : ""}
                onClick={toggleMembers}
              >
                👤
              </button>
            </div>
          </>
        ) : (
          <span className="ch-topic">
            {t("channelStart", { channel: "" })}
          </span>
        )}
      </div>

      {/* ─── Messages Area ─── */}
      <MessageList channelId={channelId} />

      {/* ─── Typing Indicator ─── */}
      <TypingIndicator channelId={channelId} />

      {/* ─── Message Input ─── */}
      <MessageInput
        sendTyping={sendTyping}
        channelId={channelId}
        channelName={channel?.name ?? ""}
      />
    </div>
  );
}

export default ChatArea;
