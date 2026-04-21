/**
 * ChatArea — Text channel view: header + messages + input.
 *
 * Wrapped in ChannelChatProvider so children access stores via context.
 * ChatAreaContent is a separate component because useChatContext()
 * must be called inside the provider.
 *
 * File drag-drop: useFileDrop makes the entire chat area a drop zone,
 * forwarding dropped files to MessageInput via addFilesRef.
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
import { IconMembers } from "../shared/Icons";
import type { Channel } from "../../types";

type ChatAreaProps = {
  channelId: string;
  channel: Channel | null;
  serverId?: string;
  sendTyping: (channelId: string) => void;
};

/** Provider wrapper — delegates content to ChatAreaContent. */
function ChatArea({ channelId, channel, serverId, sendTyping }: ChatAreaProps) {
  return (
    <ChannelChatProvider
      channelId={channelId}
      channelName={channel?.name ?? ""}
      serverId={serverId}
      sendTyping={sendTyping}
    >
      <ChatAreaContent channelId={channelId} channel={channel} serverId={serverId} />
    </ChannelChatProvider>
  );
}

/** Inner content — can call useChatContext() since it's inside the provider. */
function ChatAreaContent({
  channelId,
  channel,
  serverId,
}: {
  channelId: string;
  channel: Channel | null;
  serverId?: string;
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

  // Fetch pins and permission overrides when channel changes
  useEffect(() => {
    if (channelId) {
      fetchPins(channelId, serverId);
      fetchOverrides(channelId, serverId);
    }
  }, [channelId, serverId, fetchPins, fetchOverrides]);

  // ─── Drag-drop ───
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
              {/* Pin icon */}
              <button
                className={showPins ? "active" : ""}
                onClick={() => setShowPins((prev) => !prev)}
                title={t("pinnedMessages")}
              >
                <svg style={{ width: 16, height: 16 }} fill={pinCount > 0 ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
                </svg>
              </button>
              {/* Search icon */}
              <button
                className={showSearch ? "active" : ""}
                onClick={() => setShowSearch((prev) => !prev)}
                title={t("searchMessages")}
              >
                <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>
              {/* Member list toggle */}
              <button
                className={membersOpen ? "active" : ""}
                onClick={toggleMembers}
              >
                <IconMembers style={{ width: 16, height: 16 }} />
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
