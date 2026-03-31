/**
 * SoundUploadModal — Upload a new sound to the server soundboard.
 * Uses shared Modal component. Validates duration (max 7s) client-side before upload.
 *
 * No existing audio duration utility or file upload component exists in the codebase —
 * this is a new pattern specific to soundboard.
 */

import { useState, useRef, useCallback } from "react";
import EmojiPicker from "../shared/EmojiPicker";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import * as soundboardApi from "../../api/soundboard";
import Modal from "../shared/Modal";

type Props = {
  onClose: () => void;
};

const MAX_DURATION_MS = 7000;
const ACCEPTED_TYPES = "audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,audio/x-m4a,audio/aac,.m4a";

function SoundUploadModal({ onClose }: Props) {
  const { t } = useTranslation("soundboard");
  const serverId = useServerStore((s) => s.activeServerId);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [durationMs, setDurationMs] = useState(0);
  const [durationError, setDurationError] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setDurationError(false);
    setError("");

    if (!name) {
      const base = selected.name.replace(/\.[^.]+$/, "");
      setName(base);
    }

    const url = URL.createObjectURL(selected);
    const audio = new Audio(url);
    audio.addEventListener("loadedmetadata", () => {
      const ms = Math.round(audio.duration * 1000);
      setDurationMs(ms);
      if (ms > MAX_DURATION_MS) {
        setDurationError(true);
      }
      URL.revokeObjectURL(url);
    });
    audio.addEventListener("error", () => {
      setError(t("readError"));
      URL.revokeObjectURL(url);
    });
  }, [name]);

  const handleSubmit = async () => {
    if (!file || !serverId || !name.trim()) return;
    if (durationMs > MAX_DURATION_MS || durationMs <= 0) return;

    setIsUploading(true);
    setError("");

    const res = await soundboardApi.createSound(
      serverId,
      file,
      name.trim(),
      durationMs,
      emoji.trim() || undefined
    );

    setIsUploading(false);

    if (res.success) {
      onClose();
    } else {
      setError(res.error ?? t("uploadFailed"));
    }
  };

  const formatDuration = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  return (
    <Modal isOpen onClose={onClose} title={t("uploadSound")}>
      <div className="sb-upload-body">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_TYPES}
          onChange={handleFileChange}
          className="sb-file-input"
        />
        <button className="sb-file-btn" onClick={() => fileRef.current?.click()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" />
          </svg>
          {file ? t("changeFile") : t("selectFile")}
        </button>
        {file && (
          <div className="sb-file-info">
            <span>{file.name}</span>
            {durationMs > 0 && (
              <span className={`sb-duration${durationError ? " error" : ""}`}>
                {t("duration")}: {formatDuration(durationMs)}
                {durationError && ` — ${t("tooLong")}`}
              </span>
            )}
          </div>
        )}

        <label className="sb-label">{t("soundName")}</label>
        <input
          type="text"
          className="sb-input"
          placeholder={t("soundNamePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
        />

        <label className="sb-label">{t("emoji")}</label>
        <div className="sb-emoji-row">
          <button
            type="button"
            className="sb-emoji-btn"
            onClick={() => setShowEmojiPicker((v) => !v)}
          >
            {emoji || t("emojiPlaceholder")}
          </button>
          {emoji && (
            <button
              type="button"
              className="sb-emoji-clear"
              onClick={() => setEmoji("")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z" />
              </svg>
            </button>
          )}
          {showEmojiPicker && (
            <EmojiPicker
              onSelect={(native) => {
                setEmoji(native);
                setShowEmojiPicker(false);
              }}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}
        </div>

        <p className="sb-hint">{t("maxDuration")}</p>
        {error && <p className="sb-error">{error}</p>}
      </div>

      <div className="sb-upload-footer">
        <button className="sb-cancel-btn" onClick={onClose}>{t("cancel")}</button>
        <button
          className="sb-submit-btn"
          onClick={handleSubmit}
          disabled={!file || !name.trim() || durationError || durationMs <= 0 || isUploading}
        >
          {isUploading ? t("uploading") : t("upload")}
        </button>
      </div>
    </Modal>
  );
}

export default SoundUploadModal;
