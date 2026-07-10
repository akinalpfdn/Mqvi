import { useCallback } from "react";
import { useFileViewerStore } from "../stores/fileViewerStore";
import { resolveAssetUrl } from "../utils/constants";

type ViewableAttachment = {
  file_url: string;
  filename: string;
  mime_type?: string | null;
  file_size?: number | null;
};

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
};

/** The viewer dispatches on MIME; fall back to the extension when the record has no mime_type. */
function resolveMime(att: ViewableAttachment): string {
  if (att.mime_type) return att.mime_type;
  const ext = att.filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "";
}

/**
 * useAttachmentViewer — opens an attachment in the in-app file viewer (the same overlay chat and
 * DMs use) instead of a new browser tab. Pass the click event to suppress anchor navigation.
 */
export function useAttachmentViewer() {
  const open = useFileViewerStore((s) => s.open);

  return useCallback(
    (att: ViewableAttachment, e?: { preventDefault: () => void }) => {
      e?.preventDefault();
      open({
        src: resolveAssetUrl(att.file_url),
        filename: att.filename,
        mime: resolveMime(att),
        size: att.file_size ?? null,
      });
    },
    [open]
  );
}
