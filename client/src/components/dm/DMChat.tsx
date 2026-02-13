/**
 * DMChat — DM sohbet görünümü.
 *
 * Server kanal sohbetine benzer ama DM store'dan veri çeker.
 * PanelView'de bir tab olarak açılır (type: "dm").
 *
 * CSS class'ları: Server ChatArea'dan miras — .chat-area, .message-list, .msg-*
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import { useAuthStore } from "../../stores/authStore";
import Avatar from "../shared/Avatar";
import type { DMMessage } from "../../types";

type DMChatProps = {
  channelId: string;
};

function DMChat({ channelId }: DMChatProps) {
  const { t } = useTranslation("chat");
  const currentUser = useAuthStore((s) => s.user);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const messages = useDMStore((s) => s.messagesByChannel[channelId] ?? EMPTY_MESSAGES);
  const isLoadingMessages = useDMStore((s) => s.isLoadingMessages);
  const sendMessage = useDMStore((s) => s.sendMessage);
  const editMessage = useDMStore((s) => s.editMessage);
  const deleteMessage = useDMStore((s) => s.deleteMessage);
  const channels = useDMStore((s) => s.channels);

  const [content, setContent] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const otherUser = channels.find((ch) => ch.id === channelId)?.other_user;

  // Mesajları fetch et
  useEffect(() => {
    fetchMessages(channelId);
  }, [channelId, fetchMessages]);

  // Yeni mesaj geldiğinde en alta scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  /** Mesaj gönder */
  const handleSend = useCallback(async () => {
    if (!content.trim() || isSending) return;
    setIsSending(true);
    const success = await sendMessage(channelId, content.trim());
    if (success) {
      setContent("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
    setIsSending(false);
  }, [channelId, content, isSending, sendMessage]);

  /** Klavye — Enter gönder */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  /** Textarea auto-resize */
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setContent(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }

  /** Edit kaydet */
  async function handleEditSave(msgId: string) {
    if (editContent.trim()) {
      await editMessage(msgId, editContent.trim());
    }
    setEditingId(null);
  }

  /** Zaman formatı */
  function formatTime(dateStr: string): string {
    return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /** İki mesajın aynı gruba ait olup olmadığını kontrol et */
  function isSameGroup(prev: DMMessage | undefined, curr: DMMessage): boolean {
    if (!prev) return false;
    if (prev.user_id !== curr.user_id) return false;
    const diff = new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime();
    return diff < 5 * 60 * 1000; // 5 dakika içindeyse grupla
  }

  if (isLoadingMessages && messages.length === 0) {
    return <div className="chat-area"><div className="dm-loading">{t("loading", { ns: "common" })}</div></div>;
  }

  return (
    <div className="chat-area">
      {/* DM Header */}
      <div className="dm-header">
        <Avatar
          name={otherUser?.display_name ?? otherUser?.username ?? "?"}
          avatarUrl={otherUser?.avatar_url ?? undefined}
          size={24}
        />
        <span className="dm-header-name">
          {otherUser?.display_name ?? otherUser?.username ?? "DM"}
        </span>
      </div>

      {/* Message list */}
      <div className="message-list">
        {messages.map((msg, i) => {
          const isCompact = isSameGroup(messages[i - 1], msg);
          const isOwner = currentUser?.id === msg.user_id;
          const displayName = msg.author?.display_name ?? msg.author?.username ?? "Unknown";

          return (
            <div key={msg.id} className={`msg${!isCompact ? " first-of-group" : " grouped"}`}>
              <span className="msg-gtime">{formatTime(msg.created_at)}</span>
              <div className="msg-row">
                <div className="msg-avatar">
                  <Avatar
                    name={displayName}
                    avatarUrl={msg.author?.avatar_url ?? undefined}
                    size={30}
                  />
                </div>
                <div className="msg-body">
                  <div className="msg-meta">
                    <span className="msg-name name-default">{displayName}</span>
                    <span className="msg-time">{formatTime(msg.created_at)}</span>
                  </div>

                  {editingId === msg.id ? (
                    <div className="msg-edit-area">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleEditSave(msg.id);
                          }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="msg-edit-textarea"
                        rows={2}
                        autoFocus
                      />
                      <p className="msg-edit-hint">escape = {t("editCancel")}, enter = {t("editSave")}</p>
                    </div>
                  ) : (
                    <div className="msg-text">
                      {msg.content}
                      {msg.edited_at && <span className="msg-edited">{t("edited")}</span>}
                    </div>
                  )}
                </div>
              </div>

              {isOwner && editingId !== msg.id && (
                <div className="msg-hover-actions">
                  <button
                    onClick={() => { setEditContent(msg.content ?? ""); setEditingId(msg.id); }}
                    title={t("editMessage")}
                  >
                    <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button onClick={() => deleteMessage(msg.id)} title={t("deleteMessage")}>
                    <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="input-area">
        <div className="input-box">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={t("dmPlaceholder", { user: otherUser?.username ?? "DM" })}
            rows={1}
            disabled={isSending}
          />
          <button className="send-btn" onClick={handleSend}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

const EMPTY_MESSAGES: DMMessage[] = [];

export default DMChat;
