/** MessageAttachments — Renders file/image attachments for a message. */

import { resolveAssetUrl } from "../../utils/constants";
import EncryptedAttachment from "./EncryptedAttachment";
import type { ChatMessage } from "../../hooks/useChatContext";

type MessageAttachmentsProps = {
  message: ChatMessage;
};

function MessageAttachments({ message }: MessageAttachmentsProps) {
  const attachments = message.attachments;
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="msg-attachments">
      {attachments.map((attachment, idx) => {
        // E2EE encrypted file — decrypt via EncryptedAttachment
        const fileMeta = message.encryption_version === 1
          ? message.e2ee_file_keys?.[idx]
          : undefined;

        if (fileMeta) {
          return (
            <EncryptedAttachment
              key={attachment.id}
              attachment={attachment}
              fileMeta={fileMeta}
            />
          );
        }

        // Plaintext file — render directly
        const mime = attachment.mime_type ?? "";
        const isImage = mime.startsWith("image/");
        const isVideo = mime.startsWith("video/");
        const isAudio = mime.startsWith("audio/");

        if (isImage) {
          return (
            <a
              key={attachment.id}
              href={resolveAssetUrl(attachment.file_url)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src={resolveAssetUrl(attachment.file_url)}
                alt={attachment.filename}
                className="msg-attachment-img"
                loading="lazy"
              />
            </a>
          );
        }

        if (isVideo) {
          return (
            <video
              key={attachment.id}
              src={resolveAssetUrl(attachment.file_url)}
              controls
              className="msg-attachment-video"
              preload="metadata"
            />
          );
        }

        if (isAudio) {
          return (
            <audio
              key={attachment.id}
              src={resolveAssetUrl(attachment.file_url)}
              controls
              className="msg-attachment-audio"
              preload="metadata"
            />
          );
        }

        return (
          <a
            key={attachment.id}
            href={resolveAssetUrl(attachment.file_url)}
            download={attachment.filename}
            className="msg-attachment-file"
          >
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
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
              />
            </svg>
            <div style={{ minWidth: 0 }}>
              <p className="msg-attachment-file-name">
                {attachment.filename}
              </p>
              {attachment.file_size && (
                <p className="msg-attachment-file-size">
                  {formatFileSize(attachment.file_size)}
                </p>
              )}
            </div>
          </a>
        );
      })}
    </div>
  );
}

/** Format bytes to human-readable size (1024 -> "1.0 KB") */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default MessageAttachments;
