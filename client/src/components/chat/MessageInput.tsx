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
 */

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMessageStore } from "../../stores/messageStore";
import FilePreview from "./FilePreview";
import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES } from "../../utils/constants";

type MessageInputProps = {
  sendTyping: (channelId: string) => void;
  channelId: string;
  channelName: string;
};

function MessageInput({ sendTyping, channelId, channelName }: MessageInputProps) {
  const { t } = useTranslation("chat");
  const sendMessage = useMessageStore((s) => s.sendMessage);

  const [content, setContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Mesaj gönder */
  const handleSend = useCallback(async () => {
    if (!channelId) return;
    if (!content.trim() && files.length === 0) return;
    if (isSending) return;

    setIsSending(true);
    const success = await sendMessage(channelId, content.trim(), files);
    if (success) {
      setContent("");
      setFiles([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
    setIsSending(false);
  }, [channelId, content, files, isSending, sendMessage]);

  /** Klavye event handler */
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  /** Textarea değişikliği — typing trigger + auto-resize */
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setContent(e.target.value);

    if (channelId && e.target.value.length > 0) {
      sendTyping(channelId);
    }

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }

  /** Dosya ekleme */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;

    const newFiles = Array.from(e.target.files);
    const validFiles: File[] = [];

    for (const file of newFiles) {
      if (file.size > MAX_FILE_SIZE) continue;
      if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) continue;
      validFiles.push(file);
    }

    setFiles((prev) => [...prev, ...validFiles]);
    e.target.value = "";
  }

  /** Dosya kaldırma */
  function handleFileRemove(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  if (!channelId) return null;

  return (
    <div className="input-area">
      {/* Dosya önizleme */}
      <FilePreview files={files} onRemove={handleFileRemove} />

      <div className="input-box">
        {/* File upload button */}
        <button onClick={() => fileInputRef.current?.click()}>
          ＋
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
          placeholder={t("messagePlaceholder", { channel: channelName })}
          rows={1}
          disabled={isSending}
        />

        {/* Emoji button */}
        <button>{"\uD83D\uDE0A"}</button>

        {/* Send button */}
        <button className="send-btn" onClick={handleSend}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default MessageInput;
