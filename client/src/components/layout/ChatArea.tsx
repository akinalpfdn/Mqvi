/**
 * ChatArea — Text kanal görünümü: kanal başlığı + mesajlar + input.
 *
 * CSS class'ları: .chat-area, .channel-bar, .ch-hash, .ch-name,
 * .ch-divider, .ch-topic, .ch-actions
 *
 * Gradient overlay: .chat-area::after ile CSS'te tanımlıdır —
 * ayrı bir DOM element gerekmez. Typing ve input alanları
 * z-index:2 ile overlay'in üstünde kalır.
 *
 * ChatContext refaktörü:
 * ChannelChatProvider ile sarılır — MessageList, MessageInput,
 * TypingIndicator artık context üzerinden store'lara erişir.
 * PinnedMessages ve SearchPanel hâlâ doğrudan store kullanır
 * (channel-specific logic).
 *
 * Drag-drop dosya yükleme:
 * ChatAreaContent, useChatContext() ile addFilesRef'e erişir ve
 * useFileDrop hook'u ile tüm chat alanını drop zone yapar.
 * Drop edilen dosyalar addFilesRef üzerinden MessageInput'a iletilir.
 * İki ayrı component gerekir çünkü useChatContext() ancak
 * ChannelChatProvider'ın child'ı olarak çağrılabilir.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { usePinStore } from "../../stores/pinStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useChatContext } from "../../hooks/useChatContext";
import { useFileDrop } from "../../hooks/useFileDrop";
import ChannelChatProvider from "../chat/ChannelChatProvider";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";
import PinnedMessages from "../chat/PinnedMessages";
import SearchPanel from "../chat/SearchPanel";
import FileDropOverlay from "../shared/FileDropOverlay";
import type { Channel } from "../../types";

type ChatAreaProps = {
  channelId: string;
  channel: Channel | null;
  sendTyping: (channelId: string) => void;
};

/**
 * ChatArea — Provider wrapper.
 * ChannelChatProvider'ı render eder, içeriği ChatAreaContent'e delege eder.
 */
function ChatArea({ channelId, channel, sendTyping }: ChatAreaProps) {
  return (
    <ChannelChatProvider
      channelId={channelId}
      channelName={channel?.name ?? ""}
      sendTyping={sendTyping}
    >
      <ChatAreaContent channelId={channelId} channel={channel} />
    </ChannelChatProvider>
  );
}

/**
 * ChatAreaContent — Provider'ın child'ı olarak useChatContext() kullanabilir.
 * Drag-drop file upload burada entegre edilir.
 */
function ChatAreaContent({
  channelId,
  channel,
}: {
  channelId: string;
  channel: Channel | null;
}) {
  const { t } = useTranslation("chat");
  const { addFilesRef } = useChatContext();
  const toggleMembers = useUIStore((s) => s.toggleMembers);
  const membersOpen = useUIStore((s) => s.membersOpen);
  const getPinsForChannel = usePinStore((s) => s.getPinsForChannel);
  const fetchPins = usePinStore((s) => s.fetchPins);
  const fetchOverrides = useChannelPermissionStore((s) => s.fetchOverrides);

  const [showPins, setShowPins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  // Kanal değiştiğinde pin ve channel permission override verilerini çek
  useEffect(() => {
    if (channelId) {
      fetchPins(channelId);
      fetchOverrides(channelId);
    }
  }, [channelId, fetchPins, fetchOverrides]);

  // ─── Drag-drop entegrasyonu ───
  const handleFileDrop = useCallback(
    (files: File[]) => {
      addFilesRef.current?.(files);
    },
    [addFilesRef]
  );
  const { isDragging, dragHandlers } = useFileDrop(handleFileDrop);

  const pinCount = getPinsForChannel(channelId).length;

  return (
    <div className="chat-area" {...dragHandlers}>
      {/* ─── File Drop Overlay ─── */}
      {isDragging && <FileDropOverlay />}

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
              {/* Pin ikonu */}
              <button
                className={showPins ? "active" : ""}
                onClick={() => setShowPins((prev) => !prev)}
                title={t("pinnedMessages")}
              >
                <svg style={{ width: 16, height: 16 }} fill={pinCount > 0 ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
                </svg>
              </button>
              {/* Arama ikonu */}
              <button
                className={showSearch ? "active" : ""}
                onClick={() => setShowSearch((prev) => !prev)}
                title={t("searchMessages")}
              >
                <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>
              {/* Üye listesi toggle */}
              <button
                className={membersOpen ? "active" : ""}
                onClick={toggleMembers}
              >
                <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </button>
            </div>
          </>
        ) : (
          <span className="ch-topic">
            {t("channelStart", { channel: "" })}
          </span>
        )}
      </div>

      {/* ─── Pinned Messages Panel (overlay) ─── */}
      {showPins && (
        <PinnedMessages
          channelId={channelId}
          onClose={() => setShowPins(false)}
        />
      )}

      {/* ─── Search Panel (overlay) ─── */}
      {showSearch && (
        <SearchPanel
          channelId={channelId}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* ─── Messages Area ─── */}
      <MessageList />

      {/* ─── Typing Indicator ─── */}
      <TypingIndicator />

      {/* ─── Message Input ─── */}
      <MessageInput />
    </div>
  );
}

export default ChatArea;
