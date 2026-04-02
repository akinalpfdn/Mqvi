/** MessageInput — Message compose area. Works in both channel and DM via ChatContext. */

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { validateFiles } from "../../utils/fileValidation";
import { MAX_MESSAGE_LENGTH } from "../../utils/constants";
import EmojiPicker from "../shared/EmojiPicker";
import GifPicker from "../shared/GifPicker";
import FilePreview from "./FilePreview";
import MentionAutocomplete, { type MentionSelection } from "./MentionAutocomplete";
import ReplyBar from "./ReplyBar";

function MessageInput() {
  const { t } = useTranslation("chat");
  const {
    mode,
    channelId,
    channelName,
    serverId,
    canSend,
    sendMessage,
    replyingTo,
    setReplyingTo,
    sendTyping,
    addFilesRef,
  } = useChatContext();

  const [content, setContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);

  // Emoji picker state
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // GIF picker state
  const [showGifPicker, setShowGifPicker] = useState(false);

  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /** Character index where the @ trigger starts */
  const mentionStartRef = useRef<number>(-1);
  /** Tracked mention selections for token conversion on send */
  const mentionSelectionsRef = useRef<MentionSelection[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Register callback for drag-drop file forwarding from ChatArea/DMChat
  useEffect(() => {
    addFilesRef.current = (newFiles: File[]) => {
      setFiles((prev) => [...prev, ...newFiles]);
    };
    return () => {
      addFilesRef.current = null;
    };
  }, [addFilesRef]);

  /** Auto-focus textarea when reply is selected */
  useEffect(() => {
    if (replyingTo) {
      textareaRef.current?.focus();
    }
  }, [replyingTo]);

  /** Convert @name mentions to <@id>/<@&id> tokens before sending */
  function convertMentionTokens(text: string): string {
    let result = text;
    // Sort longest name first to prevent partial matches
    const sorted = [...mentionSelectionsRef.current].sort((a, b) => b.name.length - a.name.length);
    for (const m of sorted) {
      const token = m.type === "role" ? `<@&${m.id}>` : `<@${m.id}>`;
      // Replace all occurrences of @name (case-insensitive)
      const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`@${escaped}`, "gi"), token);
    }
    return result;
  }

  /** Send message, passing replyToId if replying */
  const handleSend = useCallback(async () => {
    if (!channelId) return;
    if (!content.trim() && files.length === 0) return;
    if (isSending) return;

    setIsSending(true);
    const replyToId = replyingTo?.id;
    const tokenized = convertMentionTokens(content.trim());
    const success = await sendMessage(tokenized, files, replyToId);
    if (success) {
      setContent("");
      setFiles([]);
      setReplyingTo(null);
      mentionSelectionsRef.current = [];
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
    setIsSending(false);

    // Restore focus after send — disabled={isSending} causes browser to drop focus
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [channelId, content, files, isSending, sendMessage, replyingTo, setReplyingTo]);

  /** Keyboard event handler */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Let mention popup handle navigation keys when open
    if (mentionQuery !== null) {
      if (["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) {
        return;
      }
    }

    // Escape — cancel reply (when mention popup is closed)
    if (e.key === "Escape" && replyingTo) {
      e.preventDefault();
      setReplyingTo(null);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  /** Textarea change — typing trigger + auto-resize + mention detection */
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setContent(value);

    if (channelId && value.length > 0) {
      sendTyping();
    }

    // Mention detection — scan backwards from cursor for @
    const cursorPos = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");

    if (atIndex >= 0) {
      const charBeforeAt = atIndex > 0 ? textBeforeCursor[atIndex - 1] : " ";
      if (charBeforeAt === " " || charBeforeAt === "\n" || atIndex === 0) {
        const query = textBeforeCursor.slice(atIndex + 1);
        // Allow spaces in query (role names can contain spaces like "Level 3")
        // Only close on newline — selection via Enter/Tab/click inserts and closes
        if (!query.includes("\n")) {
          mentionStartRef.current = atIndex;
          setMentionQuery(query);
        } else {
          setMentionQuery(null);
        }
      } else {
        setMentionQuery(null);
      }
    } else {
      setMentionQuery(null);
    }

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }

  /** Insert selected mention into content and track for token conversion */
  function handleMentionSelect(mention: MentionSelection) {
    const start = mentionStartRef.current;
    if (start < 0) return;

    mentionSelectionsRef.current.push(mention);

    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const before = content.slice(0, start);
    const after = content.slice(cursorPos);
    const displayText = `@${mention.name}`;
    const newContent = `${before}${displayText} ${after}`;

    setContent(newContent);
    setMentionQuery(null);
    mentionStartRef.current = -1;

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = start + displayText.length + 1;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    });
  }

  /** Close mention popup */
  function handleMentionClose() {
    setMentionQuery(null);
    mentionStartRef.current = -1;
  }

  /** Insert emoji at cursor position */
  function handleEmojiSelect(emoji: string) {
    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const newContent = content.slice(0, cursorPos) + emoji + content.slice(cursorPos);
    setContent(newContent);
    setShowEmojiPicker(false);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = cursorPos + emoji.length;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    });
  }

  /** Send GIF URL as message content immediately */
  async function handleGifSelect(url: string) {
    if (!channelId || isSending) return;
    setShowGifPicker(false);
    setIsSending(true);
    const success = await sendMessage(url, [], undefined);
    if (success) {
      setContent("");
      setFiles([]);
      setReplyingTo(null);
    }
    setIsSending(false);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  /** Paste handler — supports pasting images/files from clipboard */
  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }

    if (pastedFiles.length > 0) {
      e.preventDefault();
      const valid = validateFiles(pastedFiles);
      if (valid.length > 0) {
        setFiles((prev) => [...prev, ...valid]);
      }
    }
  }

  /** Add files with validation */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;

    const valid = validateFiles(e.target.files);
    if (valid.length > 0) {
      setFiles((prev) => [...prev, ...valid]);
    }
    e.target.value = "";
  }

  /** Remove file by index */
  function handleFileRemove(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  if (!channelId) return null;

  // No send permission — show disabled state
  if (!canSend) {
    return (
      <div className="input-area">
        <div className="input-box input-box-disabled">
          <span className="input-no-perm">{t("noSendPermission")}</span>
        </div>
      </div>
    );
  }

  // Placeholder: "#channel" in channel mode, "@user" in DM mode
  const placeholder = mode === "dm"
    ? t("dmPlaceholder", { user: channelName })
    : t("messagePlaceholder", { channel: channelName });

  return (
    <div className="input-area">
      {/* Mention autocomplete popup — shown above textarea */}
      {mentionQuery !== null && mode === "channel" && (
        <MentionAutocomplete
          query={mentionQuery}
          serverId={serverId}
          onSelect={handleMentionSelect}
          onClose={handleMentionClose}
        />
      )}

      {/* Reply bar — preview of the message being replied to */}
      {replyingTo && (
        <ReplyBar
          message={replyingTo}
          onCancel={() => setReplyingTo(null)}
        />
      )}

      {/* File previews */}
      <FilePreview files={files} onRemove={handleFileRemove} />

      <div className="input-box">
        {/* File upload button */}
        <button
          className="input-action-btn"
          onClick={() => fileInputRef.current?.click()}
          title={t("attachFile")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={isSending}
        />

        {/* Emoji button + picker */}
        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn"
            title={t("emoji")}
            onClick={() => {
              setShowGifPicker(false);
              setShowEmojiPicker((prev) => !prev);
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          {showEmojiPicker && (
            <div className="input-emoji-picker-wrap">
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => setShowEmojiPicker(false)}
              />
            </div>
          )}
        </div>

        {/* GIF button + picker */}
        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn input-gif-btn"
            title={t("gif")}
            onClick={() => {
              setShowEmojiPicker(false);
              setShowGifPicker((prev) => !prev);
            }}
          >
            GIF
          </button>
          {showGifPicker && (
            <div className="input-gif-picker-wrap">
              <GifPicker
                onSelect={handleGifSelect}
                onClose={() => setShowGifPicker(false)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Character counter — visible when within 100 chars of limit */}
      {content.length > MAX_MESSAGE_LENGTH - 100 && (
        <span
          className="char-counter"
          data-warn={content.length > MAX_MESSAGE_LENGTH - 50}
          data-danger={content.length > MAX_MESSAGE_LENGTH - 20}
        >
          {MAX_MESSAGE_LENGTH - content.length}
        </span>
      )}
    </div>
  );
}

export default MessageInput;
