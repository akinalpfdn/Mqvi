/**
 * DMChat — DM sohbet görünümü.
 *
 * Artık shared component'lar (MessageList, MessageInput, TypingIndicator)
 * DMChatProvider üzerinden ChatContext ile çalışıyor.
 * Eskiden monolitik bir component'ti — tüm mesaj rendering, input,
 * edit/delete burada inline yapılıyordu.
 *
 * Channel ChatArea ile aynı özellik seti:
 * - Reply (ReplyBar + referenced message preview)
 * - Reactions (EmojiPicker + reaction buttons)
 * - File upload (multipart/form-data)
 * - Pin (pin/unpin + DM pinned messages panel)
 * - Search (DM FTS5 search panel)
 * - Typing indicator
 * - Auto-focus after send (input focus bug fix)
 *
 * CSS class'ları: Server ChatArea'dan miras — .chat-area, .dm-header, vb.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import DMChatProvider from "./DMChatProvider";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";
import DMPinnedMessages from "./DMPinnedMessages";
import DMSearchPanel from "./DMSearchPanel";
import Avatar from "../shared/Avatar";

type DMChatProps = {
  channelId: string;
  sendDMTyping: (dmChannelId: string) => void;
};

function DMChat({ channelId, sendDMTyping }: DMChatProps) {
  const { t } = useTranslation("chat");
  const channels = useDMStore((s) => s.channels);
  const selectDM = useDMStore((s) => s.selectDM);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);

  const [showPins, setShowPins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const otherUser = channels.find((ch) => ch.id === channelId)?.other_user;
  const channelName = otherUser?.display_name ?? otherUser?.username ?? "DM";

  // DM tab açıldığında: selectedDMId güncelle + unread sıfırla
  useEffect(() => {
    selectDM(channelId);
    clearDMUnread(channelId);
    return () => {
      selectDM(null);
    };
  }, [channelId, selectDM, clearDMUnread]);

  /** Pin paneli aç/kapa toggle */
  const handleTogglePins = useCallback(() => {
    setShowPins((prev) => !prev);
  }, []);

  /** Arama paneli aç/kapa toggle */
  const handleToggleSearch = useCallback(() => {
    setShowSearch((prev) => !prev);
  }, []);

  return (
    <DMChatProvider
      channelId={channelId}
      channelName={channelName}
      sendDMTyping={sendDMTyping}
    >
      <div className="chat-area">
        {/* ─── DM Header ─── */}
        <div className="dm-header">
          <Avatar
            name={channelName}
            avatarUrl={otherUser?.avatar_url ?? undefined}
            size={24}
          />
          <span className="dm-header-name">{channelName}</span>

          {/* Header actions — pin, search */}
          <div className="ch-actions">
            {/* Pin ikonu */}
            <button
              className={showPins ? "active" : ""}
              onClick={handleTogglePins}
              title={t("pinnedMessages")}
            >
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
              </svg>
            </button>
            {/* Arama ikonu */}
            <button
              className={showSearch ? "active" : ""}
              onClick={handleToggleSearch}
              title={t("searchMessages")}
            >
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          </div>
        </div>

        {/* ─── DM Pinned Messages Panel ─── */}
        {showPins && (
          <DMPinnedMessages
            channelId={channelId}
            onClose={() => setShowPins(false)}
          />
        )}

        {/* ─── DM Search Panel ─── */}
        {showSearch && (
          <DMSearchPanel
            channelId={channelId}
            onClose={() => setShowSearch(false)}
          />
        )}

        {/* ─── Messages Area (shared component) ─── */}
        <MessageList />

        {/* ─── Typing Indicator (shared component) ─── */}
        <TypingIndicator />

        {/* ─── Message Input (shared component) ─── */}
        <MessageInput />
      </div>
    </DMChatProvider>
  );
}

export default DMChat;
