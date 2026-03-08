/**
 * EncryptedAttachment — displays E2EE encrypted file attachments.
 * Downloads encrypted file from server, decrypts with AES-256-GCM.
 * Images auto-decrypt on mount; files decrypt on click.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { decryptFile } from "../../crypto/fileEncryption";
import { resolveAssetUrl } from "../../utils/constants";
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

  const doDecrypt = useCallback(async () => {
    if (state === "loading" || state === "ready") return;

    setState("loading");
    try {
      const url = resolveAssetUrl(attachment.file_url);
      const decryptedFile = await decryptFile(url, fileMeta);

      const blobUrl = URL.createObjectURL(decryptedFile);

      // Revoke previous URL
      if (revokeRef.current) {
        URL.revokeObjectURL(revokeRef.current);
      }
      revokeRef.current = blobUrl;

      setObjectUrl(blobUrl);
      setState("ready");
    } catch (err) {
      console.error("[EncryptedAttachment] Decrypt failed:", err);
      setState("error");
    }
  }, [attachment.file_url, fileMeta, state]);

  // Auto-decrypt images on mount
  useEffect(() => {
    if (isImage && state === "idle") {
      doDecrypt();
    }
  }, [isImage, state, doDecrypt]);

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

    // ready — show decrypted image
    return (
      <a href={objectUrl!} target="_blank" rel="noopener noreferrer">
        <img
          src={objectUrl!}
          alt={fileMeta.filename}
          className="msg-attachment-img"
          loading="lazy"
        />
      </a>
    );
  }

  // ─── File rendering ───
  const handleFileClick = async (e: React.MouseEvent) => {
    e.preventDefault();

    if (state === "ready" && objectUrl) {
      // Already decrypted — start download
      triggerDownload(objectUrl, fileMeta.filename);
      return;
    }

    if (state === "loading") return;

    // Decrypt and download
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
      triggerDownload(blobUrl, fileMeta.filename);
    } catch (err) {
      console.error("[EncryptedAttachment] Decrypt failed:", err);
      setState("error");
    }
  };

  return (
    <a
      href="#"
      onClick={handleFileClick}
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
              : formatFileSize(fileMeta.originalSize)}
        </p>
      </div>
    </a>
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

/** Programmatic file download */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Format file size to human-readable string (1024 → "1.0 KB") */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export default EncryptedAttachment;
