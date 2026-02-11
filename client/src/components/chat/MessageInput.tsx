/**
 * MessageInput — Mesaj yazma alanı.
 *
 * Özellikler:
 * - Enter = gönder, Shift+Enter = yeni satır
 * - Dosya ekleme (file input ile)
 * - Typing indicator trigger (3sn throttle — useWebSocket'ten gelen sendTyping)
 * - Client-side dosya validasyonu (boyut + MIME type)
 * - Auto-resize textarea (içerik büyüdükçe yükseklik artar)
 */

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMessageStore } from "../../stores/messageStore";
import { useChannelStore } from "../../stores/channelStore";
import FilePreview from "./FilePreview";
import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES } from "../../utils/constants";

type MessageInputProps = {
  sendTyping: (channelId: string) => void;
};

function MessageInput({ sendTyping }: MessageInputProps) {
  const { t } = useTranslation("chat");
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const categories = useChannelStore((s) => s.categories);
  const sendMessage = useMessageStore((s) => s.sendMessage);

  const [content, setContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Seçili kanalın adı (placeholder için) */
  const channelName = categories
    .flatMap((cg) => cg.channels)
    .find((ch) => ch.id === selectedChannelId)?.name ?? "";

  /** Mesaj gönder */
  const handleSend = useCallback(async () => {
    if (!selectedChannelId) return;
    if (!content.trim() && files.length === 0) return;
    if (isSending) return;

    setIsSending(true);
    const success = await sendMessage(selectedChannelId, content.trim(), files);
    if (success) {
      setContent("");
      setFiles([]);
      // Textarea yüksekliğini sıfırla
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
    setIsSending(false);
  }, [selectedChannelId, content, files, isSending, sendMessage]);

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

    // Typing indicator trigger
    if (selectedChannelId && e.target.value.length > 0) {
      sendTyping(selectedChannelId);
    }

    // Auto-resize
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
      // Boyut kontrolü
      if (file.size > MAX_FILE_SIZE) {
        // TODO: Toast notification ile göster
        continue;
      }
      // MIME type kontrolü
      if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) {
        continue;
      }
      validFiles.push(file);
    }

    setFiles((prev) => [...prev, ...validFiles]);
    // Input'u sıfırla (aynı dosya tekrar seçilebilsin)
    e.target.value = "";
  }

  /** Dosya kaldırma */
  function handleFileRemove(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  if (!selectedChannelId) return null;

  return (
    <div className="px-4 pb-6 pt-1">
      {/* Dosya önizleme */}
      <FilePreview files={files} onRemove={handleFileRemove} />

      <div className="flex items-end rounded-lg bg-input px-4 py-1">
        {/* File upload button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="mr-4 flex h-11 shrink-0 items-center text-text-muted transition-colors hover:text-text-secondary"
        >
          <svg
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={t("messagePlaceholder", { channel: channelName })}
          className="h-11 max-h-[200px] flex-1 resize-none bg-transparent py-2.5 text-base leading-[1.375rem] text-text-primary outline-none placeholder:text-text-muted"
          rows={1}
          disabled={isSending}
        />
      </div>
    </div>
  );
}

export default MessageInput;
