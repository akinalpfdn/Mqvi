/**
 * EncryptedAttachment — displays E2EE encrypted file attachments.
 * Downloads encrypted file from server, decrypts with AES-256-GCM.
 * Only the small companion preview is decrypted on mount; the full attachment waits until the user
 * opens it. Messages predating thumbnails have none, and those still decrypt the whole image inline
 * so old conversations do not go blank.
 *
 * The component owns both blob URL lifecycles: they live while the surrounding message is rendered
 * and are revoked on unmount.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { decryptFile, decryptThumbnail } from "../../crypto/fileEncryption";
import { resolveAssetUrl } from "../../utils/constants";
import { formatBytes } from "../../utils/formatBytes";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import ProgressRing from "../shared/ProgressRing";
import type { EncryptedFileMeta } from "../../crypto/fileEncryption";
import type { ChatAttachment } from "../../hooks/useChatContext";

type DecryptState = "idle" | "loading" | "ready" | "error";

type EncryptedAttachmentProps = {
  attachment: ChatAttachment;
  /** Matching file_keys entry (by index order) */
  fileMeta: EncryptedFileMeta;
};

function EncryptedAttachment({ attachment, fileMeta }: EncryptedAttachmentProps) {
  const { t } = useTranslation("e2ee");
  const openViewer = useFileViewerStore((s) => s.open);
  const [state, setState] = useState<DecryptState>("idle");
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const revokeRef = useRef<string | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  /** Preview decrypt failed — the image falls back to the original rather than sitting on "decrypting". */
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbRevokeRef = useRef<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isImage = fileMeta.mimeType.startsWith("image/");
  const isVideo = fileMeta.mimeType.startsWith("video/");
  // A video has no inline preview at all without a poster, so it is worth decrypting one for.
  const canPreview = isImage || isVideo;

  // Object URL cleanup on unmount
  useEffect(() => {
    return () => {
      if (revokeRef.current) {
        URL.revokeObjectURL(revokeRef.current);
        revokeRef.current = null;
      }
      if (thumbRevokeRef.current) {
        URL.revokeObjectURL(thumbRevokeRef.current);
        thumbRevokeRef.current = null;
      }
      // Scrolling a message out of view should stop its download, not keep pulling megabytes for
      // something no longer on screen.
      abortRef.current?.abort();
    };
  }, []);

  const doDecrypt = useCallback(async (): Promise<string | null> => {
    if (state === "ready" && objectUrl) return objectUrl;
    if (state === "loading") return null;

    setState("loading");
    try {
      const url = resolveAssetUrl(attachment.file_url);
      const controller = new AbortController();
      abortRef.current = controller;
      setProgress({ loaded: 0, total: null });
      const decryptedFile = await decryptFile(url, fileMeta, {
        signal: controller.signal,
        onProgress: (loaded, total) => setProgress({ loaded, total }),
      });
      const blobUrl = URL.createObjectURL(decryptedFile);

      if (revokeRef.current) {
        URL.revokeObjectURL(revokeRef.current);
      }
      revokeRef.current = blobUrl;

      setObjectUrl(blobUrl);
      setProgress(null);
      setState("ready");
      return blobUrl;
    } catch (err) {
      console.error("[EncryptedAttachment] Decrypt failed:", err);
      setProgress(null);
      setState("error");
      return null;
    }
  }, [attachment.file_url, fileMeta, state, objectUrl]);

  // Decrypt the small PREVIEW once — a few tens of kB instead of the whole attachment. This is the
  // point of thumbnails: opening a channel used to download and decrypt every image at full size.
  // Keyed on the thumbnail's identity alone, NOT on `state`: folding `state`/`doDecrypt` in here
  // re-ran this on every idle→loading→ready step, re-decrypting the preview and leaking its blob URL
  // each time the user opened the original.
  useEffect(() => {
    if (!canPreview) return;
    const thumbSource = attachment.thumb_url;
    if (!thumbSource || !fileMeta.thumbIv) return;

    let cancelled = false;
    setThumbFailed(false);
    decryptThumbnail(resolveAssetUrl(thumbSource), fileMeta.key, fileMeta.thumbIv)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        // A prior preview (e.g. after the source message was replaced) must be revoked, not leaked.
        if (thumbRevokeRef.current) URL.revokeObjectURL(thumbRevokeRef.current);
        thumbRevokeRef.current = url;
        setThumbUrl(url);
      })
      .catch(() => {
        // Swallowing this silently left the row stuck on "decrypting" forever, because the fallback
        // below skips any attachment that HAS a thumbnail. The common trigger is a stale signed URL:
        // the one in the store expires after an hour, so scrolling back to an old message remounts
        // this with a 401. Record the failure so the original is fetched instead.
        if (!cancelled) setThumbFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [canPreview, attachment.thumb_url, fileMeta.thumbIv, fileMeta.key]);

  // An image whose preview is missing or unusable is decrypted whole, so messages predating
  // thumbnails — and ones whose thumbnail just failed — still render instead of going blank. A video
  // never falls back this way: that would pull the entire attachment just for a frame, so it drops
  // to the file row instead.
  useEffect(() => {
    if (!isImage) return;
    const hasUsablePreview = Boolean(attachment.thumb_url && fileMeta.thumbIv) && !thumbFailed;
    if (hasUsablePreview) return;
    if (state === "idle") doDecrypt();
  }, [isImage, attachment.thumb_url, fileMeta.thumbIv, thumbFailed, state, doDecrypt]);

  const openInViewer = useCallback(async () => {
    const url = state === "ready" && objectUrl ? objectUrl : await doDecrypt();
    if (!url) return;
    openViewer({
      src: url,
      filename: fileMeta.filename,
      mime: fileMeta.mimeType,
      size: fileMeta.originalSize,
    });
  }, [state, objectUrl, doDecrypt, openViewer, fileMeta]);

  // ─── Preview rendering (image, or a video with a poster) ───
  // A video with no poster has nothing to show and nothing decrypting, so it must fall through to
  // the file row rather than sit forever on a "decrypting" state that will never resolve.
  if (isImage || (isVideo && thumbUrl)) {
    // The preview stands in for the full image. `state` describes the ORIGINAL, which stays idle
    // until the user opens it — so gating the picture on state would hide a thumbnail we already
    // decrypted.
    const preview = thumbUrl ?? (state === "ready" ? objectUrl : null);
    if (preview) {
      return (
        <button
          type="button"
          className="msg-attachment-imgbtn"
          onClick={openInViewer}
          aria-label={fileMeta.filename}
        >
          <img
            src={preview}
            alt={fileMeta.filename}
            className="msg-attachment-img"
            width={attachment.thumb_width ?? undefined}
            height={attachment.thumb_height ?? undefined}
          />
          {/* The original is on its way — the preview stays visible underneath. Indeterminate
              until the response reports a length. */}
          {state === "loading" && (
            <ProgressRing
              percent={
                progress && progress.total ? (progress.loaded / progress.total) * 100 : null
              }
            />
          )}
          {/* With a preview showing, the error row below is unreachable — a failed open would just
              do nothing at all and leave the user clicking a picture that never expands. */}
          {state === "error" && (
            <span className="msg-attachment-img-error">{t("fileDecryptFailed")}</span>
          )}
          {/* Without this a poster is indistinguishable from a photo. */}
          {isVideo && state !== "loading" && state !== "error" && (
            <span className="attachment-play-badge" aria-hidden />
          )}
        </button>
      );
    }

    if (state === "loading" || state === "idle") {
      return (
        <div className="msg-attachment-file">
          <EncryptedFileIcon />
          <div style={{ minWidth: 0 }}>
            <p className="msg-attachment-file-name">{fileMeta.filename}</p>
            <p className="msg-attachment-file-size">{t("decryptingFile")}</p>
          </div>
        </div>
      );
    }

    if (state === "error") {
      return (
        <div className="msg-attachment-file">
          <EncryptedFileIcon />
          <div style={{ minWidth: 0 }}>
            <p className="msg-attachment-file-name">{fileMeta.filename}</p>
            <p className="msg-attachment-file-size" style={{ color: "var(--danger)" }}>
              {t("fileDecryptFailed")}
            </p>
          </div>
        </div>
      );
    }

    // Unreachable in practice: `preview` above already covers ready-with-a-blob. Kept as an
    // explicit nothing rather than a stale copy of the image branch.
    return null;
  }

  // ─── File rendering ───
  return (
    <button
      type="button"
      onClick={openInViewer}
      className="msg-attachment-file"
    >
      <EncryptedFileIcon />
      <div style={{ minWidth: 0 }}>
        <p className="msg-attachment-file-name">{fileMeta.filename}</p>
        <p className="msg-attachment-file-size">
          {state === "loading"
            ? t("decryptingFile")
            : state === "error"
              ? t("fileDecryptFailed")
              : formatBytes(fileMeta.originalSize)}
        </p>
      </div>
    </button>
  );
}

// ─── Helpers ───

/** Encrypted file icon (lock + file) */
function EncryptedFileIcon() {
  return (
    <svg
      className="msg-attachment-file-icon"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
      />
    </svg>
  );
}

export default EncryptedAttachment;
