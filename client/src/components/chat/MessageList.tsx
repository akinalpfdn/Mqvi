/** MessageList — Scrollable message container with auto-scroll, infinite scroll, and compact mode. */

import { useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { MessageSkeleton } from "../shared/Skeleton";
import Message from "./Message";
import CallLogRow from "./CallLogRow";
import { useChatLayoutStore } from "../../hooks/useNarrowChat";

/** Below this column width the message layout switches to the compact (mobile-style) mode.
 *  Kept in sync with the `@container (max-width:600px)` rule in globals.css. */
const NARROW_COLUMN_WIDTH = 600;

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
  const members = useActiveMembers();

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Reflow the message layout by the column's real width (survives sidebar toggles / split-view).
  const narrowObserverRef = useRef<ResizeObserver | null>(null);
  const setViewportRef = useCallback((el: HTMLDivElement | null) => {
    narrowObserverRef.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) useChatLayoutStore.getState().setIsNarrow(w < NARROW_COLUMN_WIDTH);
    });
    ro.observe(el);
    narrowObserverRef.current = ro;
  }, []);
  // Intent flag: "user wants to stay pinned to bottom". Only the user scrolling
  // UP invalidates it; programmatic scrollTo / image-load resize do not.
  const stickToBottomRef = useRef(true);
  const prevScrollTopRef = useRef(0);
  const prevMessageCountRef = useRef(0);

  // ─── Mention Navigation State ───
  const lastMentionSeen = useReadStateStore((s) => s.lastMentionSeen[channelId]);
  const markMentionSeen = useReadStateStore((s) => s.markMentionSeen);

  const mentionMessageIds = useMemo(() => {
    if (!currentUser) return [];
    const myMember = members.find((m) => m.id === currentUser.id);
    const myRoleIds = myMember?.roles?.length
      ? new Set(myMember.roles.map((r) => r.id))
      : null;

    const ids: string[] = [];
    for (const msg of messages) {
      if (lastMentionSeen) {
        if (msg.created_at < lastMentionSeen.at) continue;
        if (msg.created_at === lastMentionSeen.at && msg.id <= lastMentionSeen.messageId) continue;
      }

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
  }, [messages, currentUser, members, lastMentionSeen]);

  const mentionCount = mentionMessageIds.length;

  function handleMentionNavClick() {
    if (mentionCount === 0) return;
    const msgId = mentionMessageIds[0];
    const msg = messages.find((m) => m.id === msgId);

    // Advance the watermark — server-persisted, survives hard refresh
    if (msg) markMentionSeen(channelId, msgId, msg.created_at);

    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-highlight");
      setTimeout(() => el.classList.remove("msg-highlight"), 2000);
    }
  }

  useEffect(() => {
    stickToBottomRef.current = false;
    if (channelId) fetchMessages();
  }, [channelId, fetchMessages]);

  // Auto-scroll on new message when intent is sticky.
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && stickToBottomRef.current) {
      scrollToBottom();
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  // Re-pin to bottom while async content (images, embeds, GIFs) expands the
  // container. Uses the intent flag, not a position re-measurement, so the
  // programmatic-scroll → handleScroll feedback loop can't unstick.
  useEffect(() => {
    if (!contentRef.current) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [isLoading, channelId]);

  // Re-pin when the scroll viewport itself changes height — the soft keyboard opening shrinks
  // .messages-scroll (via #root's keyboard padding) without changing content size, so the
  // contentRef observer above never fires for it and the newest message would hide behind the
  // composer. Keyed on clientHeight so a plain scrollTop change can't loop back in here.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let prevHeight = scroller.clientHeight;
    const observer = new ResizeObserver(() => {
      const h = scroller.clientHeight;
      // Only re-pin when the viewport SHRINKS (keyboard opening, window narrowing) — that's when
      // the newest message would slip behind the composer. On grow, a bottom-anchored scroll stays
      // put, and re-pinning mid-resize-drag on desktop just adds jitter.
      const shrank = h < prevHeight;
      prevHeight = h;
      if (shrank && stickToBottomRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [isLoading, channelId]);

  /** Restore scroll position — runs before paint via useLayoutEffect. */
  useLayoutEffect(() => {
    if (!isLoading && messages.length > 0 && scrollRef.current) {
      const savedPos = scrollPositions.get(channelId);
      if (savedPos !== undefined) {
        scrollRef.current.scrollTop = savedPos;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        stickToBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;
      } else {
        scrollToBottom();
        stickToBottomRef.current = true;
      }
      prevMessageCountRef.current = messages.length;
      prevScrollTopRef.current = scrollRef.current.scrollTop;
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

  /** Scroll handler — direction-based intent tracking + persist position + infinite scroll. */
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const prev = prevScrollTopRef.current;

    // Only USER scroll-up unstuck intent; programmatic scrolls (scrollToBottom on resize,
    // infinite-scroll restore) move scrollTop forward, never decrease it.
    if (scrollTop < prev - 5) {
      stickToBottomRef.current = false;
    }
    if (scrollHeight - scrollTop - clientHeight < 20) {
      stickToBottomRef.current = true;
    }
    prevScrollTopRef.current = scrollTop;

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
    return <div className="no-channel">{t("noChannel")}</div>;
  }

  if (isLoading) {
    return (
      <div className="messages-scroll">
        <MessageSkeleton count={6} />
      </div>
    );
  }

  // Welcome icon: "#" for channels, "@" for DMs, speaker for voice
  const welcomeIcon = mode === "dm" ? "@" : mode === "voice" ? "🔊" : "#";

  return (
    <div className="chat-msg-viewport" ref={setViewportRef} style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
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
                : mode === "voice"
                  ? t("welcomeVoice", { channel: channelName })
                  : t("welcomeChannel", { channel: channelName })}
            </h2>
            <p>
              {mode === "dm"
                ? t("dmStart", { user: channelName })
                : mode === "voice"
                  ? t("voiceStart")
                  : t("channelStart", { channel: channelName })}
            </p>
          </div>
        ) : (
          <div ref={contentRef} style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "8px 0" }}>
            {messages.map((msg, index) => (
              <div key={msg.id} id={`msg-${msg.id}`}>
                {msg.message_type === "call" && msg.call_meta ? (
                  <CallLogRow meta={msg.call_meta} createdAt={msg.created_at} />
                ) : (
                  <Message
                    message={msg}
                    isCompact={isCompact(index)}
                  />
                )}
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
