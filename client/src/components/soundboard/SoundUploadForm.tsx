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
import { useUploadProgress } from "../../hooks/useUploadProgress";
import { useFileRejectionNotice } from "../../hooks/useFileRejectionNotice";
import { MAX_FILE_SIZE } from "../../utils/constants";
import UploadProgress from "../shared/UploadProgress";

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

// Decode the source audio and produce a WAV of ONLY the [startMs, endMs] segment.
// The trimmed clip is what gets uploaded — the full-length audio never reaches
// the server, so a long sound can't be stored or replayed in full.
async function trimAudioToWav(file: File, startMs: number, endMs: number): Promise<File> {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const sampleRate = decoded.sampleRate;
    const startSample = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
    const endSample = Math.min(decoded.length, Math.floor((endMs / 1000) * sampleRate));
    const length = Math.max(1, endSample - startSample);

    const trimmed = audioCtx.createBuffer(decoded.numberOfChannels, length, sampleRate);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const segment = decoded.getChannelData(ch).subarray(startSample, startSample + length);
      trimmed.copyToChannel(segment, ch, 0);
    }

    const wavBlob = audioBufferToWav(trimmed);
    const baseName = file.name.replace(/\.[^.]+$/, "");
    return new File([wavBlob], `${baseName}-trim.wav`, { type: "audio/wav" });
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
  const [startInput, setStartInput] = useState("0.0");
  const [endInput, setEndInput] = useState("0.0");
  const [isUploading, setIsUploading] = useState(false);
  const { progress: uploadProgress, begin: beginUpload, end: endUpload, cancel: cancelUpload } =
    useUploadProgress();
  const notifyRejected = useFileRejectionNotice();
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

  // Keep the manual time fields in sync when trim changes from dragging or load.
  useEffect(() => { setStartInput((trimStart / 1000).toFixed(1)); }, [trimStart]);
  useEffect(() => { setEndInput((trimEnd / 1000).toFixed(1)); }, [trimEnd]);

  // Manual time edits push the other handle instead of being clamped: moving
  // start past end drags end forward (preserving region length), and vice
  // versa. Only when a value stays in bounds does the other handle stay put.
  const commitStart = useCallback((raw: string) => {
    const sec = parseFloat(raw);
    if (isNaN(sec)) { setStartInput((trimStart / 1000).toFixed(1)); return; }
    const ns = Math.max(0, Math.min(Math.round(sec * 1000), totalDurationMs));
    const region = Math.min(Math.max(trimEnd - trimStart, 200), MAX_DURATION_MS);
    let ne = trimEnd;
    let start = ns;
    if (ne < start + 200) {
      ne = start + region;
      if (ne > totalDurationMs) { ne = totalDurationMs; start = Math.max(0, ne - region); }
    } else if (ne - start > MAX_DURATION_MS) {
      ne = start + MAX_DURATION_MS;
    }
    setTrimStart(start);
    setTrimEnd(ne);
  }, [trimStart, trimEnd, totalDurationMs]);

  const commitEnd = useCallback((raw: string) => {
    const sec = parseFloat(raw);
    if (isNaN(sec)) { setEndInput((trimEnd / 1000).toFixed(1)); return; }
    const ne = Math.max(0, Math.min(Math.round(sec * 1000), totalDurationMs));
    const region = Math.min(Math.max(trimEnd - trimStart, 200), MAX_DURATION_MS);
    let ns = trimStart;
    let end = ne;
    if (ns > end - 200) {
      ns = end - region;
      if (ns < 0) { ns = 0; end = Math.min(totalDurationMs, ns + region); }
    } else if (end - ns > MAX_DURATION_MS) {
      ns = end - MAX_DURATION_MS;
    }
    setTrimStart(ns);
    setTrimEnd(end);
  }, [trimStart, trimEnd, totalDurationMs]);

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

    // Video sources get decoded to WAV in-browser before upload, so an oversized pick has to be
    // refused here — otherwise it is fully decoded first and only then rejected by the server.
    if (selected.size > MAX_FILE_SIZE) {
      notifyRejected([selected], { reason: "size", maxBytes: MAX_FILE_SIZE });
      e.target.value = "";
      return;
    }

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

    let uploadFile: File;
    try {
      uploadFile = await trimAudioToWav(file, trimStart, trimEnd);
    } catch {
      setIsUploading(false);
      setError(t("readError"));
      return;
    }

    const res = await soundboardApi.createSound(
      serverId,
      uploadFile,
      name.trim(),
      trimmedDurationMs,
      emoji.trim() || undefined,
      beginUpload()
    );
    endUpload();
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

        {file && totalDurationMs > 0 && (
          <div className="sb-trim-times">
            <label className="sb-trim-field">
              <span>{t("startTime")}</span>
              <input
                type="number"
                className="sb-input sb-trim-input"
                step={0.1}
                min={0}
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                onBlur={(e) => commitStart(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitStart((e.target as HTMLInputElement).value); }}
              />
            </label>
            <label className="sb-trim-field">
              <span>{t("endTime")}</span>
              <input
                type="number"
                className="sb-input sb-trim-input"
                step={0.1}
                min={0}
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                onBlur={(e) => commitEnd(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitEnd((e.target as HTMLInputElement).value); }}
              />
            </label>
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

        {uploadProgress && (
          <UploadProgress
            loaded={uploadProgress.loaded}
            total={uploadProgress.total}
            onCancel={cancelUpload}
          />
        )}
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
