/**
 * SoundUploadForm — Inline upload form shown inside SoundboardPanel (same popup).
 * Replaces the grid view when adding a new sound. No separate modal.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import EmojiPicker from "../shared/EmojiPicker";
import WaveformTrimmer from "./WaveformTrimmer";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import * as soundboardApi from "../../api/soundboard";

type Props = {
  onClose: () => void;
};

const MAX_DURATION_MS = 7000;
const ACCEPTED_TYPES =
  "audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,audio/x-m4a,audio/aac,.m4a,video/mp4,.mp4";

function isVideoFile(file: File): boolean {
  return file.type === "video/mp4" || (file.name.toLowerCase().endsWith(".mp4") && !file.type.startsWith("audio/"));
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const headerLength = 44;
  const arrayBuffer = new ArrayBuffer(headerLength + dataLength);
  const view = new DataView(arrayBuffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

async function extractAudioFromVideo(file: File): Promise<File> {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const wavBlob = audioBufferToWav(audioBuffer);
    const baseName = file.name.replace(/\.[^.]+$/, "");
    return new File([wavBlob], `${baseName}.wav`, { type: "audio/wav" });
  } finally {
    await audioCtx.close();
  }
}

function SoundUploadForm({ onClose }: Props) {
  const { t } = useTranslation("soundboard");
  const serverId = useServerStore((s) => s.activeServerId);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [totalDurationMs, setTotalDurationMs] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playTimerRef = useRef<number>(0);

  const trimmedDurationMs = trimEnd - trimStart;
  const durationError = trimmedDurationMs > MAX_DURATION_MS;
  const canSubmit = !!file && name.trim().length > 0 && !durationError && trimmedDurationMs > 0 && !isUploading && !isConverting;

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    };
  }, [objectUrl]);

  const loadAudioMeta = useCallback((audioFile: File) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const url = URL.createObjectURL(audioFile);
    setObjectUrl(url);

    const audio = new Audio(url);
    audio.addEventListener("loadedmetadata", () => {
      const ms = Math.round(audio.duration * 1000);
      setTotalDurationMs(ms);
      setTrimStart(0);
      setTrimEnd(Math.min(ms, MAX_DURATION_MS));
    });
    audio.addEventListener("error", () => setError(t("readError")));
  }, [objectUrl, t]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setError("");

    if (!name) {
      setName(selected.name.replace(/\.[^.]+$/, ""));
    }

    if (isVideoFile(selected)) {
      setIsConverting(true);
      try {
        const wavFile = await extractAudioFromVideo(selected);
        setFile(wavFile);
        loadAudioMeta(wavFile);
      } catch {
        setError(t("videoConvertError"));
      } finally {
        setIsConverting(false);
      }
    } else {
      setFile(selected);
      loadAudioMeta(selected);
    }
  }, [name, loadAudioMeta, t]);

  const handlePreview = () => {
    if (!objectUrl) return;

    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
      setIsPlaying(false);
      return;
    }

    const audio = new Audio(objectUrl);
    audioRef.current = audio;
    audio.currentTime = trimStart / 1000;
    audio.play().catch(() => {});
    setIsPlaying(true);

    playTimerRef.current = window.setTimeout(() => {
      audio.pause(); audioRef.current = null; setIsPlaying(false);
    }, trimmedDurationMs);

    audio.addEventListener("ended", () => { setIsPlaying(false); audioRef.current = null; });
  };

  const handleSubmit = async () => {
    if (!file || !serverId || !canSubmit) return;

    setIsUploading(true);
    setError("");

    const res = await soundboardApi.createSound(serverId, file, name.trim(), trimmedDurationMs, emoji.trim() || undefined);
    setIsUploading(false);

    if (res.success) {
      onClose();
    } else {
      setError(res.error ?? t("uploadFailed"));
    }
  };

  return (
    <div className="sb-upload-view">
      <div className="sb-header">
        <button className="sb-back-btn" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
        </button>
        <span className="sb-title">{t("uploadSound")}</span>
      </div>

      <div className="sb-upload-body">
        <input ref={fileRef} type="file" accept={ACCEPTED_TYPES} onChange={handleFileChange} className="sb-file-input" />
        <button className="sb-file-btn" onClick={() => fileRef.current?.click()} disabled={isConverting}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" />
          </svg>
          {isConverting ? t("converting") : file ? t("changeFile") : t("selectFile")}
        </button>
        <span className="sb-format-hint">{t("supportedFormats")}</span>

        {file && totalDurationMs > 0 && objectUrl && (
          <WaveformTrimmer
            fileUrl={objectUrl}
            totalDurationMs={totalDurationMs}
            maxDurationMs={MAX_DURATION_MS}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onTrimChange={(s, e) => { setTrimStart(s); setTrimEnd(e); }}
            isPlaying={isPlaying}
            onTogglePlay={handlePreview}
          />
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
          <button type="button" className="sb-emoji-btn" onClick={() => setShowEmojiPicker((v) => !v)}>
            {emoji || t("emojiPlaceholder")}
          </button>
          {emoji && (
            <button type="button" className="sb-emoji-clear" onClick={() => setEmoji("")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z" />
              </svg>
            </button>
          )}
          {showEmojiPicker && (
            <EmojiPicker
              onSelect={(native) => { setEmoji(native); setShowEmojiPicker(false); }}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}
        </div>

        {error && <p className="sb-error">{error}</p>}
      </div>

      <div className="sb-upload-footer">
        <button className="sb-cancel-btn" onClick={onClose}>{t("cancel")}</button>
        <button className="sb-submit-btn" onClick={handleSubmit} disabled={!canSubmit}>
          {isUploading ? t("uploading") : t("upload")}
        </button>
      </div>
    </div>
  );
}

export default SoundUploadForm;
