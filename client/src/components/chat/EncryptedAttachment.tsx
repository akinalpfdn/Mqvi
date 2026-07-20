/**
 * EncryptedAttachment — displays E2EE encrypted file attachments.
 * Downloads encrypted file from server, decrypts with AES-256-GCM.
 * Images auto-decrypt on mount so the thumbnail can render inline; clicking
 * any attachment opens the in-app FileViewerOverlay with the decrypted blob
 * URL. The component owns the blob URL lifecycle: it stays mounted while the
 * surrounding message is rendered, and revokes on unmount.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { decryptFile } from "../../crypto/fileEncryption";
import { resolveAssetUrl } from "../../utils/constants";
import { formatBytes } from "../../utils/formatBytes";
import { useFileViewerStore } from "../../stores/fileViewerStore";
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

  const isImage = fileMeta.mimeType.startsWith("image/");

  // Object URL cleanup on unmount
  useEffect(() => {
    return () => {
      if (revokeRef.current) {
        URL.revokeObjectURL(revokeRef.current);
        revokeRef.current = null;
      }
    };
  }, []);

  const doDecrypt = useCallback(async (): Promise<string | null> => {
    if (state === "ready" && objectUrl) return objectUrl;
    if (state === "loading") return null;

    setState("loading");
    try {
      const url = resolveAssetUrl(attachment.file_url);
      const decryptedFile = await decryptFile(url, fileMeta);
      const blobUrl = URL.createObjectURL(decryptedFile);

      if (revokeRef.current) {
        URL.revokeObjectURL(revokeRef.current);
      }
      revokeRef.current = blobUrl;

      setObjectUrl(blobUrl);
      setState("ready");
      return blobUrl;
    } catch (err) {
      console.error("[EncryptedAttachment] Decrypt failed:", err);
      setState("error");
      return null;
    }
  }, [attachment.file_url, fileMeta, state, objectUrl]);

  // Auto-decrypt images on mount for inline thumbnail.
  useEffect(() => {
    if (isImage && state === "idle") {
      doDecrypt();
    }
  }, [isImage, state, doDecrypt]);

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

  // ─── Image rendering ───
  if (isImage) {
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

    // ready — show decrypted image, click opens viewer
    return (
      <button
        type="button"
        className="msg-attachment-imgbtn"
        onClick={openInViewer}
        aria-label={fileMeta.filename}
      >
        <img
          src={objectUrl!}
          alt={fileMeta.filename}
          className="msg-attachment-img"
          loading="lazy"
        />
      </button>
    );
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
