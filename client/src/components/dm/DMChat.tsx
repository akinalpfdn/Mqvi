/**
 * DMChat — DM chat view using shared components via ChatContext.
 * Split into DMChat (provider wrapper) and DMChatContent (needs ChatContext).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import { authorDisplayName, authorAvatarURL, isAuthorDeleted } from "../../utils/deletedUser";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";
import { useBlockStore } from "../../stores/blockStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useChatContext } from "../../hooks/useChatContext";
import { useConfirm } from "../../hooks/useConfirm";
import { useFileDrop } from "../../hooks/useFileDrop";
import { useNarrowChat } from "../../hooks/useNarrowChat";
import { useContextMenu } from "../../hooks/useContextMenu";
import ContextMenu from "../shared/ContextMenu";
import DMChatProvider from "./DMChatProvider";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";
import DMPinnedMessages from "./DMPinnedMessages";
import DMSearchPanel from "./DMSearchPanel";
import FileDropOverlay from "../shared/FileDropOverlay";
import Avatar from "../shared/Avatar";
import * as e2eeApi from "../../api/e2ee";
import { useAuthStore } from "../../stores/authStore";
import type { User } from "../../types";

type DMChatProps = {
  channelId: string;
  sendDMTyping: (dmChannelId: string) => void;
};

/** DMChat — Provider wrapper. Delegates content to DMChatContent. */
function DMChat({
  channelId,
  sendDMTyping,
}: DMChatProps) {
  const channels = useDMStore((s) => s.channels);
  const otherUser = channels.find((ch) => ch.id === channelId)?.other_user;
  const channelName = authorDisplayName(otherUser, "DM");

  return (
    <DMChatProvider
      channelId={channelId}
      channelName={channelName}
      otherUser={otherUser ?? null}
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
  const { t: tDM } = useTranslation("dm");
  const { t: tCommon } = useTranslation("common");
  const { t: tE2EE } = useTranslation("e2ee");
  const { addFilesRef } = useChatContext();
  const confirm = useConfirm();
  const isNarrow = useNarrowChat();
  const { menuState, openMenuAt, closeMenu } = useContextMenu();
  const selectDM = useDMStore((s) => s.selectDM);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const invalidateMessages = useDMStore((s) => s.invalidateMessages);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const toggleE2EE = useDMStore((s) => s.toggleE2EE);
  const e2eeInitStatus = useE2EEStore((s) => s.initStatus);
  const channels = useDMStore((s) => s.channels);
  const dmE2EEEnabled = channels.find((ch) => ch.id === channelId)?.e2ee_enabled ?? false;
  const addToast = useToastStore((s) => s.addToast);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const acceptDMRequest = useDMStore((s) => s.acceptDMRequest);
  const declineDMRequest = useDMStore((s) => s.declineDMRequest);
  const blockUser = useBlockStore((s) => s.blockUser);

  const dmChannel = channels.find((ch) => ch.id === channelId);
  const isPending = dmChannel?.status === "pending";
  const isInitiator = isPending && dmChannel?.initiated_by === currentUserId;
  const isRecipient = isPending && !isInitiator;
  // Other party deleted/tombstoned: history is browsable, but no calls/E2EE
  // negotiation/new messages — backend would reject these anyway.
  const otherUserDeleted = isAuthorDeleted(otherUser);

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
    if (!dmE2EEEnabled || !otherUser || otherUserDeleted) {
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
  }, [dmE2EEEnabled, otherUser, otherUserDeleted]);

  /** Toggle pin panel */
  const handleTogglePins = useCallback(() => {
    setShowPins((prev) => !prev);
  }, []);

  /** Toggle search panel */
  const handleToggleSearch = useCallback(() => {
    setShowSearch((prev) => !prev);
  }, []);

  const e2eeLabel = dmE2EEEnabled ? tE2EE("disableE2EE") : tE2EE("enableE2EE");

  const handleToggleE2EE = useCallback(async () => {
    const newState = !dmE2EEEnabled;
    const confirmed = await confirm({
      title: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
      message: newState ? tE2EE("enableE2EEConfirmDM") : tE2EE("disableE2EEConfirmDM"),
      confirmLabel: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
      danger: !newState,
    });
    if (!confirmed) return;

    const ok = await toggleE2EE(channelId, newState);
    addToast(ok ? "success" : "error", ok
      ? (newState ? tE2EE("e2eeEnabled") : tE2EE("e2eeDisabled"))
      : tE2EE("e2eeToggleFailed"));
  }, [dmE2EEEnabled, confirm, tE2EE, toggleE2EE, channelId, addToast]);

  const handleOpenOverflow = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      openMenuAt(e, [
        { label: t("pinnedMessages"), onClick: handleTogglePins },
        { label: t("searchMessages"), onClick: handleToggleSearch },
        ...(otherUserDeleted
          ? []
          : [{ label: e2eeLabel, onClick: () => void handleToggleE2EE(), separator: true }]),
      ]);
    },
    [openMenuAt, t, handleTogglePins, handleToggleSearch, otherUserDeleted, e2eeLabel, handleToggleE2EE]
  );

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
          avatarUrl={authorAvatarURL(otherUser)}
          size={24}
        />
        <span className="dm-header-name">{channelName}</span>

        {/* Header actions — e2ee, pin, search */}
        <div className="ch-actions">
          {/* E2EE toggle — hidden when recipient is deleted (no negotiation possible). */}
          {!otherUserDeleted && !isNarrow && (
            <button
              className={dmE2EEEnabled ? "active" : ""}
              onClick={handleToggleE2EE}
              title={e2eeLabel}
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
          )}
          {/* Voice + video call — hidden if other party is deleted (cannot be reached). */}
          {!otherUserDeleted && (
            <>
              <button
                onClick={() => {
                  if (otherUser) useP2PCallStore.getState().initiateCall(otherUser.id, "voice");
                }}
                title={tCommon("voiceCall")}
              >
                <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
                </svg>
              </button>
              <button
                onClick={() => {
                  if (otherUser) useP2PCallStore.getState().initiateCall(otherUser.id, "video");
                }}
                title={tCommon("videoCall")}
              >
                <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9.75a2.25 2.25 0 002.25-2.25V7.5a2.25 2.25 0 00-2.25-2.25H4.5A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </button>
            </>
          )}
          {/* Pin toggle */}
          {!isNarrow && (
            <button
              className={showPins ? "active" : ""}
              onClick={handleTogglePins}
              title={t("pinnedMessages")}
            >
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
              </svg>
            </button>
          )}
          {/* Search toggle */}
          {!isNarrow && (
            <button
              className={showSearch ? "active" : ""}
              onClick={handleToggleSearch}
              title={t("searchMessages")}
            >
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          )}
          {/* Narrow columns cannot hold five 44px targets and a name: the calls stay, the
              rest move into an overflow so the name keeps its room. */}
          {isNarrow && (
            <button
              onClick={handleOpenOverflow}
              // Keep the composer focused so the soft keyboard doesn't collapse under the menu.
              onMouseDown={(e) => e.preventDefault()}
              title={tCommon("more")}
            >
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="5" r="1" fill="currentColor" />
                <circle cx="12" cy="12" r="1" fill="currentColor" />
                <circle cx="12" cy="19" r="1" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* ─── E2EE Recipient No Keys Banner ─── */}
      {dmE2EEEnabled && !recipientHasKeys && (
        <div className="e2ee-warning-banner">
          <svg style={{ width: 16, height: 16, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{tE2EE("recipientNoKeysBanner")}</span>
        </div>
      )}

      {/* ─── DM Request Banner ─── Skipped if other party is deleted: accept/block
           on a tombstoned account is meaningless and would just produce errors. */}
      {isRecipient && !otherUserDeleted && (
        <div className="dm-request-banner">
          <span>{tDM("dmRequestReceived", { name: channelName })}</span>
          <div className="dm-request-actions">
            <button className="dm-request-accept" onClick={() => acceptDMRequest(channelId)}>
              {tDM("dmRequestAccept")}
            </button>
            <button className="dm-request-decline" onClick={() => declineDMRequest(channelId)}>
              {tDM("dmRequestDecline")}
            </button>
            <button
              className="dm-request-block"
              onClick={() => {
                if (otherUser) {
                  blockUser(otherUser.id);
                  declineDMRequest(channelId);
                }
              }}
            >
              {tDM("blockUser")}
            </button>
          </div>
        </div>
      )}
      {/* "Waiting" banner skipped if recipient is deleted — they can't accept. */}
      {isInitiator && !otherUserDeleted && (
        <div className="dm-request-banner dm-request-banner--waiting">
          <span>{tDM("dmRequestWaiting")}</span>
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
      {/* Hidden when DM is pending (request flow) or recipient is deleted. */}
      {isPending || otherUserDeleted ? null : (
        <MessageInput
          openSearch={() => setShowSearch(true)}
        />
      )}
    </div>
  );
}

export default DMChat;
