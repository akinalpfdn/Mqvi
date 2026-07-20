/**
 * Thumbnail for a ticket/report attachment.
 *
 * Feedback used to render every attachment as an <img>; now that video is accepted, that would
 * paint a broken image box. Video gets a real element instead.
 */

type AttachmentPreviewProps = {
  url: string;
  filename: string;
  mime?: string | null;
};

// Only containers the serve layer will hand back inline (see pkg/files/safemime.go). .ogv is left
// out on purpose: video/ogg is not inline-safe there, so it arrives as a download and a <video>
// element would render an empty box.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

function AttachmentPreview({ url, filename, mime }: AttachmentPreviewProps) {
  const isVideo = (mime ?? "").startsWith("video/") || VIDEO_EXT.test(filename);

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

  return <img src={url} alt={filename} />;
}

export default AttachmentPreview;
