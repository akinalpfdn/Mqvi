/**
 * DMChat — DM chat view using shared components via ChatContext.
 * Split into DMChat (provider wrapper) and DMChatContent (needs ChatContext).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";
import { useChatContext } from "../../hooks/useChatContext";
import { useConfirm } from "../../hooks/useConfirm";
import { useFileDrop } from "../../hooks/useFileDrop";
import DMChatProvider from "./DMChatProvider";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";
import DMPinnedMessages from "./DMPinnedMessages";
import DMSearchPanel from "./DMSearchPanel";
import FileDropOverlay from "../shared/FileDropOverlay";
import Avatar from "../shared/Avatar";
import * as e2eeApi from "../../api/e2ee";
import type { User } from "../../types";

type DMChatProps = {
  channelId: string;
  sendDMTyping: (dmChannelId: string) => void;
};

/** DMChat — Provider wrapper. Delegates content to DMChatContent. */
function DMChat({ channelId, sendDMTyping }: DMChatProps) {
  const channels = useDMStore((s) => s.channels);
  const otherUser = channels.find((ch) => ch.id === channelId)?.other_user;
  const channelName = otherUser?.display_name ?? otherUser?.username ?? "DM";

  return (
    <DMChatProvider
      channelId={channelId}
      channelName={channelName}
      sendDMTyping={sendDMTyping}
    >
      <DMChatContent
        channelId={channelId}
        channelName={channelName}
        otherUser={otherUser ?? null}
      />
    </DMChatProvider>
  );
}

/** DMChatContent — Child of provider, integrates drag-drop file upload. */
function DMChatContent({
  channelId,
  channelName,
  otherUser,
}: {
  channelId: string;
  channelName: string;
  otherUser: User | null;
}) {
  const { t } = useTranslation("chat");
  const { t: tE2EE } = useTranslation("e2ee");
  const { addFilesRef } = useChatContext();
  const confirm = useConfirm();
  const selectDM = useDMStore((s) => s.selectDM);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const invalidateMessages = useDMStore((s) => s.invalidateMessages);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const toggleE2EE = useDMStore((s) => s.toggleE2EE);
  const e2eeInitStatus = useE2EEStore((s) => s.initStatus);
  const channels = useDMStore((s) => s.channels);
  const dmE2EEEnabled = channels.find((ch) => ch.id === channelId)?.e2ee_enabled ?? false;
  const addToast = useToastStore((s) => s.addToast);

  const [showPins, setShowPins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [recipientHasKeys, setRecipientHasKeys] = useState(true); // default true — assume ok until checked
  const pendingSearchChannelId = useDMStore((s) => s.pendingSearchChannelId);
  const setPendingSearchChannelId = useDMStore((s) => s.setPendingSearchChannelId);

  // Update selectedDMId + clear unread when DM tab opens
  useEffect(() => {
    selectDM(channelId);
    clearDMUnread(channelId);
    return () => {
      selectDM(null);
    };
  }, [channelId, selectDM, clearDMUnread]);

  // Invalidate + re-fetch messages when E2EE transitions to "ready".
  // Prevents race condition where fetchMessages runs before e2eeStore.initialize()
  // completes, caching all messages with null content.
  const prevE2eeStatusRef = useRef(e2eeInitStatus);
  useEffect(() => {
    const prevStatus = prevE2eeStatusRef.current;
    prevE2eeStatusRef.current = e2eeInitStatus;

    // Only invalidate on non-ready -> ready transition
    if (e2eeInitStatus === "ready" && prevStatus !== "ready") {
      invalidateMessages(channelId);
      fetchMessages(channelId);
    }
  }, [e2eeInitStatus, channelId, invalidateMessages, fetchMessages]);

  // Auto-open search panel when triggered from context menu
  useEffect(() => {
    if (pendingSearchChannelId === channelId) {
      setShowSearch(true);
      setPendingSearchChannelId(null);
    }
  }, [pendingSearchChannelId, channelId, setPendingSearchChannelId]);

  // Check recipient's key status when E2EE is active (for warning banner)
  useEffect(() => {
    if (!dmE2EEEnabled || !otherUser) {
      setRecipientHasKeys(true);
      return;
    }
    let cancelled = false;
    e2eeApi.listUserDevices(otherUser.id).then((res) => {
      if (cancelled) return;
      setRecipientHasKeys(res.success && !!res.data && res.data.length > 0);
    }).catch(() => {
      if (!cancelled) setRecipientHasKeys(true); // don't show banner on error
    });
    return () => { cancelled = true; };
  }, [dmE2EEEnabled, otherUser]);

  /** Toggle pin panel */
  const handleTogglePins = useCallback(() => {
    setShowPins((prev) => !prev);
  }, []);

  /** Toggle search panel */
  const handleToggleSearch = useCallback(() => {
    setShowSearch((prev) => !prev);
  }, []);

  // ─── Drag-drop ───
  const handleFileDrop = useCallback(
    (files: File[]) => {
      addFilesRef.current?.(files);
    },
    [addFilesRef]
  );
  const { isDragging, dragHandlers } = useFileDrop(handleFileDrop);

  return (
    <div className="chat-area" {...dragHandlers}>
      {/* ─── File Drop Overlay ─── */}
      {isDragging && <FileDropOverlay />}

      {/* ─── DM Header ─── */}
      <div className="dm-header">
        <Avatar
          name={channelName}
          avatarUrl={otherUser?.avatar_url ?? undefined}
          size={24}
        />
        <span className="dm-header-name">{channelName}</span>

        {/* Header actions — e2ee, pin, search */}
        <div className="ch-actions">
          {/* E2EE toggle */}
          <button
            className={dmE2EEEnabled ? "active" : ""}
            onClick={async () => {
              const newState = !dmE2EEEnabled;
              const confirmed = await confirm({
                title: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
                message: newState ? tE2EE("enableE2EEConfirmDM") : tE2EE("disableE2EEConfirmDM"),
                confirmLabel: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
                danger: !newState,
              });
              if (!confirmed) return;
              const ok = await toggleE2EE(channelId, newState);
              if (ok) {
                addToast("success", newState ? tE2EE("e2eeEnabled") : tE2EE("e2eeDisabled"));
              } else {
                addToast("error", tE2EE("e2eeToggleFailed"));
              }
            }}
            title={dmE2EEEnabled ? tE2EE("disableE2EE") : tE2EE("enableE2EE")}
          >
            {dmE2EEEnabled ? (
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            ) : (
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 019.9-1" />
              </svg>
            )}
          </button>
          {/* Pin toggle */}
          <button
            className={showPins ? "active" : ""}
            onClick={handleTogglePins}
            title={t("pinnedMessages")}
          >
            <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
            </svg>
          </button>
          {/* Search toggle */}
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

      {/* ─── E2EE Recipient No Keys Banner ─── */}
      {dmE2EEEnabled && !recipientHasKeys && (
        <div className="e2ee-warning-banner">
          <svg style={{ width: 16, height: 16, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{tE2EE("recipientNoKeysBanner")}</span>
        </div>
      )}

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
  );
}

export default DMChat;
