/** MessageAttachments — Renders file/image attachments for a message. */

import { resolveAssetUrl } from "../../utils/constants";
import { formatBytes } from "../../utils/formatBytes";
import EncryptedAttachment from "./EncryptedAttachment";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import type { ChatAttachment, ChatMessage } from "../../hooks/useChatContext";

type MessageAttachmentsProps = {
  message: ChatMessage;
};

function MessageAttachments({ message }: MessageAttachmentsProps) {
  const attachments = message.attachments;
  const openViewer = useFileViewerStore((s) => s.open);
  if (!attachments || attachments.length === 0) return null;

  function open(att: ChatAttachment) {
    openViewer({
      src: resolveAssetUrl(att.file_url),
      filename: att.filename,
      mime: att.mime_type ?? "",
      size: att.file_size ?? null,
    });
  }

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
            <button
              key={attachment.id}
              type="button"
              className="msg-attachment-imgbtn"
              onClick={() => open(attachment)}
              aria-label={attachment.filename}
            >
              {/* The preview when there is one — the original is only fetched once opened. Width
                  and height come from the stored dimensions so the list does not reflow on load. */}
              <img
                src={resolveAssetUrl(attachment.thumb_url ?? attachment.file_url)}
                alt={attachment.filename}
                className="msg-attachment-img"
                loading="lazy"
                width={attachment.thumb_width ?? undefined}
                height={attachment.thumb_height ?? undefined}
              />
            </button>
          );
        }

        if (isVideo) {
          // Inline player: plays in place, no new tab. Native controls expose
          // fullscreen + "save video as" so an overlay handoff is unnecessary.
          //
          // #t=0.1 is what gives it a preview frame. preload="metadata" gets the dimensions and
          // the controls on every platform, but a mobile browser will not paint the first frame
          // until playback starts — so the message showed a black box with a stretched play
          // glyph in it. The media fragment makes the browser seek to 0.1s and paint THAT frame,
          // which it will happily do because the file endpoint serves ranges (http.ServeContent).
          // The cost is that playback starts 100ms in.
          //
          // playsInline: without it iOS hijacks the tap into its own fullscreen player.
          // With a stored poster none of that applies: the frame is a separate small image, so
          // preload="none" means the video itself is not touched until the user presses play.
          // Without one we fall back to the media-fragment trick above.
          const posterUrl = attachment.thumb_url ? resolveAssetUrl(attachment.thumb_url) : null;
          return (
            <video
              key={attachment.id}
              src={resolveAssetUrl(attachment.file_url) + (posterUrl ? "" : "#t=0.1")}
              poster={posterUrl ?? undefined}
              controls
              playsInline
              className="msg-attachment-video"
              preload={posterUrl ? "none" : "metadata"}
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
          <button
            key={attachment.id}
            type="button"
            onClick={() => open(attachment)}
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
                  {formatBytes(attachment.file_size)}
                </p>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export default MessageAttachments;
