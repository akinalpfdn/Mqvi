/**
 * Which attachments the server will actually hand back inline.
 *
 * Decided from the filename extension, because that is what the serve layer decides from
 * (ServeDisposition in pkg/files/safemime.go reads the path, never the stored mime_type). The
 * stored type is the uploader's declared Content-Type — a clip.mkv announced as "video/mp4" passes
 * a mime check and still arrives as a download, leaving a player element with nothing to play.
 */

/** Video containers in the server's inline-safe list. */
const INLINE_VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

/** Every video container the app accepts — the rest can only be downloaded. */
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi|ogv|3gp)$/i;

/** True when a `<video>` pointed at this file can actually play it. */
export function isInlineVideo(filename: string): boolean {
  return INLINE_VIDEO_EXT.test(filename);
}

/** True for any video container, including the ones that only ever download. */
export function isVideoFile(filename: string): boolean {
  return VIDEO_EXT.test(filename);
}
