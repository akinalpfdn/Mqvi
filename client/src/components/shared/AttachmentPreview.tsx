/**
 * Thumbnail for a ticket/report attachment.
 *
 * Feedback used to render every attachment as an <img>; now that video is accepted, that would
 * paint a broken image box. Video gets a real element instead.
 */

import { isInlineVideo, isVideoFile } from "../../utils/inlineMedia";

type AttachmentPreviewProps = {
  url: string;
  filename: string;
  mime?: string | null;
};

function AttachmentPreview({ url, filename, mime }: AttachmentPreviewProps) {
  const declared = (mime ?? "").toLowerCase();
  const isVideo = isInlineVideo(filename);

  if (isVideo) {
    // #t=0.1 is what gives it a poster frame: with preload="metadata" a mobile browser will not
    // paint the first frame until playback starts, so the thumb would be a black box. The media
    // fragment makes it seek to 0.1s and paint THAT frame, which the range-serving file endpoint
    // supports.
    return (
      <video
        src={`${url}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        aria-label={filename}
      />
    );
  }

  // A video container the serve layer will not hand back inline (.mkv, .ogv — both accepted on
  // upload on purpose). Neither element can render it: <video> paints an empty box and <img> a
  // broken-image icon, so say what it is and let the surrounding link download it.
  if (declared.startsWith("video/") || isVideoFile(filename)) {
    return <span className="attachment-preview-file">{filename}</span>;
  }

  return <img src={url} alt={filename} />;
}

export default AttachmentPreview;
