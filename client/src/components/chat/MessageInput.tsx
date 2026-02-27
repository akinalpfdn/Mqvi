/**
 * MessageInput — Mesaj yazma alanı.
 *
 * CSS class'ları: .input-area, .input-box, .send-btn
 * .input-box button, .input-box textarea CSS'te tanımlıdır.
 *
 * Özellikler:
 * - Enter = gönder, Shift+Enter = yeni satır
 * - Dosya ekleme (file input ile)
 * - Typing indicator trigger (3sn throttle)
 * - Auto-resize textarea
 *
 * ChatContext refaktörü:
 * Eskiden sendTyping, channelId, channelName, canSend props alıyordu.
 * Artık tüm bu değerler useChatContext() üzerinden geliyor.
 * Hem channel hem DM'de aynı component çalışıyor.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { validateFiles } from "../../utils/fileValidation";
import EmojiPicker from "../shared/EmojiPicker";
import FilePreview from "./FilePreview";
import MentionAutocomplete from "./MentionAutocomplete";
import ReplyBar from "./ReplyBar";

function MessageInput() {
  const { t } = useTranslation("chat");
  const {
    mode,
    channelId,
    channelName,
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

  /** Emoji picker state */
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  /** Mention autocomplete state */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /** Mention başladığı karakter index'i (@ karakterinin konumu) */
  const mentionStartRef = useRef<number>(-1);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * addFilesRef register — ChatArea/DMChat drag-drop'tan dosya iletimi.
   * Drag-drop event'inde addFilesRef.current?.(files) çağrılır,
   * burada register edilen callback files state'ine ekler.
   */
  useEffect(() => {
    addFilesRef.current = (newFiles: File[]) => {
      setFiles((prev) => [...prev, ...newFiles]);
    };
    return () => {
      addFilesRef.current = null;
    };
  }, [addFilesRef]);

  /** Reply seçildiğinde textarea'ya otomatik focus ver */
  useEffect(() => {
    if (replyingTo) {
      textareaRef.current?.focus();
    }
  }, [replyingTo]);

  /** Mesaj gönder — reply varsa replyToId olarak iletir */
  const handleSend = useCallback(async () => {
    if (!channelId) return;
    if (!content.trim() && files.length === 0) return;
    if (isSending) return;

    setIsSending(true);
    const replyToId = replyingTo?.id;
    const success = await sendMessage(content.trim(), files, replyToId);
    if (success) {
      setContent("");
      setFiles([]);
      setReplyingTo(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
    setIsSending(false);

    // Gönderim sonrası focus'u textarea'ya geri ver.
    // disabled={isSending} geçici olarak textarea'yı devre dışı bırakır,
    // tarayıcı bu sırada focus'u kaldırır — burada geri yüklüyoruz.
    // Bu aynı zamanda DM input focus bug'ını da çözer.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [channelId, content, files, isSending, sendMessage, replyingTo, setReplyingTo]);

  /** Klavye event handler */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Mention popup açıkken Enter/Tab/ArrowUp/Down → popup'a bırak
    if (mentionQuery !== null) {
      if (["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) {
        return;
      }
    }

    // Escape — reply iptal et (mention popup kapalıysa)
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

  /** Textarea değişikliği — typing trigger + auto-resize + mention detection */
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setContent(value);

    if (channelId && value.length > 0) {
      sendTyping();
    }

    // Mention detection — cursor konumundan geriye bakarak @ ara
    // DM modunda mention kullanılmaz, ama MentionAutocomplete
    // zaten DM'de boş sonuç döneceği için sorun yok.
    const cursorPos = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");

    if (atIndex >= 0) {
      const charBeforeAt = atIndex > 0 ? textBeforeCursor[atIndex - 1] : " ";
      if (charBeforeAt === " " || charBeforeAt === "\n" || atIndex === 0) {
        const query = textBeforeCursor.slice(atIndex + 1);
        if (!query.includes(" ") && !query.includes("\n")) {
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

  /**
   * handleMentionSelect — Autocomplete'ten kullanıcı seçildiğinde çağrılır.
   */
  function handleMentionSelect(username: string) {
    const start = mentionStartRef.current;
    if (start < 0) return;

    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const before = content.slice(0, start);
    const after = content.slice(cursorPos);
    const newContent = `${before}@${username} ${after}`;

    setContent(newContent);
    setMentionQuery(null);
    mentionStartRef.current = -1;

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = start + username.length + 2;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    });
  }

  /** Mention popup kapatma */
  function handleMentionClose() {
    setMentionQuery(null);
    mentionStartRef.current = -1;
  }

  /**
   * handleEmojiSelect — EmojiPicker'dan emoji seçildiğinde çağrılır.
   * Emojiyi textarea'da cursor pozisyonuna ekler ve cursor'ı emojinin sonuna taşır.
   */
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

  /**
   * handlePaste — Clipboard'dan dosya/görsel yapıştırma desteği.
   * Ctrl+V ile clipboard'daki görseller FilePreview'a eklenir.
   * Sadece dosya varsa preventDefault yapılır — metin paste'i etkilenmez.
   */
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

  /** Dosya ekleme — validateFiles utility kullanır */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;

    const valid = validateFiles(e.target.files);
    if (valid.length > 0) {
      setFiles((prev) => [...prev, ...valid]);
    }
    e.target.value = "";
  }

  /** Dosya kaldırma */
  function handleFileRemove(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  if (!channelId) return null;

  // Mesaj gönderme yetkisi yoksa disabled durum göster
  if (!canSend) {
    return (
      <div className="input-area">
        <div className="input-box input-box-disabled">
          <span className="input-no-perm">{t("noSendPermission")}</span>
        </div>
      </div>
    );
  }

  // Placeholder: Channel modunda "#kanal" formatı, DM modunda "@kullanıcı" formatı
  const placeholder = mode === "dm"
    ? t("dmPlaceholder", { user: channelName })
    : t("messagePlaceholder", { channel: channelName });

  return (
    <div className="input-area">
      {/* Mention autocomplete popup — textarea'nın üstünde gösterilir */}
      {mentionQuery !== null && mode === "channel" && (
        <MentionAutocomplete
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={handleMentionClose}
        />
      )}

      {/* Reply bar — yanıt verilen mesajın önizlemesi */}
      {replyingTo && (
        <ReplyBar
          message={replyingTo}
          onCancel={() => setReplyingTo(null)}
        />
      )}

      {/* Dosya önizleme */}
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
          disabled={isSending}
        />

        {/* Emoji button + picker */}
        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn"
            title={t("emoji")}
            onClick={() => setShowEmojiPicker((prev) => !prev)}
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
      </div>
    </div>
  );
}

export default MessageInput;
