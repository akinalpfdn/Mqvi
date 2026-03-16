/** MessageList — Scrollable message container with auto-scroll, infinite scroll, and compact mode. */

import { useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { MessageSkeleton } from "../shared/Skeleton";
import Message from "./Message";

/** Compact threshold for consecutive messages from same author (ms) */
const COMPACT_THRESHOLD = 5 * 60 * 1000;

/** Per-channel scroll position cache. Survives component unmount/remount. */
const scrollPositions = new Map<string, number>();

function MessageList() {
  const { t } = useTranslation("chat");
  const {
    mode,
    channelId,
    channelName,
    messages,
    isLoading,
    isLoadingMore,
    hasMore,
    fetchMessages,
    fetchOlderMessages,
    scrollToMessageId,
    setScrollToMessageId,
  } = useChatContext();

  const currentUser = useAuthStore((s) => s.user);
  const members = useMemberStore((s) => s.members);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);

  // ─── Mention Navigation State ───
  const seenMentions = useReadStateStore((s) => s.seenMentions[channelId]);
  const markMentionSeen = useReadStateStore((s) => s.markMentionSeen);

  // Compute unseen mention message IDs (exclude already-seen mentions)
  const mentionMessageIds = useMemo(() => {
    if (!currentUser) return [];
    const myMember = members.find((m) => m.id === currentUser.id);
    const myRoleIds = myMember?.roles?.length
      ? new Set(myMember.roles.map((r) => r.id))
      : null;

    const ids: string[] = [];
    for (const msg of messages) {
      // Skip mentions already seen by the user
      if (seenMentions?.has(msg.id)) continue;

      if (msg.mentions?.includes(currentUser.id)) {
        ids.push(msg.id);
        continue;
      }
      if (msg.role_mentions?.length && myRoleIds) {
        if (msg.role_mentions.some((rid) => myRoleIds.has(rid))) {
          ids.push(msg.id);
        }
      }
    }
    return ids;
  }, [messages, currentUser, members, seenMentions]);

  const mentionCount = mentionMessageIds.length;

  function handleMentionNavClick() {
    if (mentionCount === 0) return;
    const msgId = mentionMessageIds[0];

    // Mark as seen — removes from the list permanently (survives channel switch)
    markMentionSeen(channelId, msgId);

    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-highlight");
      setTimeout(() => el.classList.remove("msg-highlight"), 2000);
    }
  }

  // Fetch messages on channel change, disable auto-scroll during transition
  useEffect(() => {
    isAtBottomRef.current = false;

    if (channelId) {
      fetchMessages();
    }
  }, [channelId, fetchMessages]);

  // Auto-scroll on new message (only when already at bottom)
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && isAtBottomRef.current) {
      scrollToBottom();
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  /** Restore scroll position — runs before paint via useLayoutEffect. */
  useLayoutEffect(() => {
    if (!isLoading && messages.length > 0 && scrollRef.current) {
      const savedPos = scrollPositions.get(channelId);
      if (savedPos !== undefined) {
        scrollRef.current.scrollTop = savedPos;
      } else {
        scrollToBottom();
      }
      prevMessageCountRef.current = messages.length;
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;
    }
  }, [isLoading, channelId]);

  /** Scroll-to-message effect — triggered when reply preview is clicked. */
  useEffect(() => {
    if (!scrollToMessageId) return;

    const el = document.getElementById(`msg-${scrollToMessageId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-highlight");
      const timer = setTimeout(() => {
        el.classList.remove("msg-highlight");
      }, 2000);
      setScrollToMessageId(null);
      return () => clearTimeout(timer);
    }

    setScrollToMessageId(null);
  }, [scrollToMessageId, setScrollToMessageId]);

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }

  /** Scroll handler — save position + check if at bottom + trigger infinite scroll */
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;

    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;

    if (channelId) {
      scrollPositions.set(channelId, scrollTop);
    }

    if (scrollTop < 100 && hasMore && !isLoadingMore && channelId) {
      const prevScrollHeight = scrollRef.current.scrollHeight;
      fetchOlderMessages().then(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop =
            scrollRef.current.scrollHeight - prevScrollHeight;
        }
      });
    }
  }, [hasMore, isLoadingMore, channelId, fetchOlderMessages]);

  /** Compact mode for consecutive messages from same author within 5min. Replies always show full header. */
  function isCompact(index: number): boolean {
    if (index === 0) return false;

    const current = messages[index];
    if (current.reply_to_id) return false;

    const previous = messages[index - 1];

    if (current.user_id !== previous.user_id) return false;

    const timeDiff =
      new Date(current.created_at).getTime() -
      new Date(previous.created_at).getTime();

    return timeDiff < COMPACT_THRESHOLD;
  }

  if (!channelId) {
    return <div className="no-channel">Select a channel</div>;
  }

  if (isLoading) {
    return (
      <div className="messages-scroll">
        <MessageSkeleton count={6} />
      </div>
    );
  }

  // Welcome icon: "#" for channels, "@" for DMs
  const welcomeIcon = mode === "dm" ? "@" : "#";

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="messages-scroll"
      >
        {/* Loading more indicator */}
        {isLoadingMore && (
          <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
            <div className="spinner" />
          </div>
        )}

        {/* Messages */}
        {messages.length === 0 ? (
          <div className="msg-welcome">
            <div className="msg-welcome-icon">
              <span>{welcomeIcon}</span>
            </div>
            <h2>
              {mode === "dm"
                ? t("welcomeDM", { user: channelName })
                : t("welcomeChannel", { channel: channelName })}
            </h2>
            <p>
              {mode === "dm"
                ? t("dmStart", { user: channelName })
                : t("channelStart", { channel: channelName })}
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "8px 0" }}>
            {messages.map((msg, index) => (
              <div key={msg.id} id={`msg-${msg.id}`}>
                <Message
                  message={msg}
                  isCompact={isCompact(index)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mention Navigation FAB */}
      {mentionCount > 0 && (
        <button
          className="mention-nav-fab"
          onClick={handleMentionNavClick}
          title={t("jumpToMention")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
          </svg>
          <span>{mentionCount}</span>
        </button>
      )}
    </div>
  );
}

export default MessageList;
