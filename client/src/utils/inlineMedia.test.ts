import { describe, it, expect } from "vitest";
import { isInlineVideo, isVideoFile } from "./inlineMedia";

/**
 * Both the thumbnail and the full-screen viewer key off these, and they have to agree with the
 * server's inline-safe list. A .mkv that reads as playable renders an empty box: the serve layer
 * hands it back as a download, whatever the uploader declared its Content-Type to be.
 */
describe("isInlineVideo", () => {
  it.each(["clip.mp4", "clip.webm", "clip.mov", "clip.m4v", "CLIP.MP4", "a.b.c.mov"])(
    "treats %s as playable inline",
    (name) => expect(isInlineVideo(name)).toBe(true)
  );

  // Accepted on upload on purpose, but never served inline — a player pointed at one shows nothing.
  it.each(["clip.mkv", "clip.ogv", "clip.avi", "clip.3gp"])(
    "does not promise %s can play inline",
    (name) => expect(isInlineVideo(name)).toBe(false)
  );

  it.each(["photo.jpg", "notes.pdf", "archive.zip", "noextension", ""])(
    "rejects %s, which is not video at all",
    (name) => expect(isInlineVideo(name)).toBe(false)
  );

  // The extension has to be the real one. "mp4" inside the name is not a container.
  it("does not match an extension appearing mid-name", () => {
    expect(isInlineVideo("mp4-recording.txt")).toBe(false);
    expect(isInlineVideo("my.mov.txt")).toBe(false);
  });
});

describe("isVideoFile", () => {
  it("covers every container the app accepts, playable or not", () => {
    for (const name of ["a.mp4", "a.webm", "a.mov", "a.m4v", "a.mkv", "a.avi", "a.ogv", "a.3gp"]) {
      expect(isVideoFile(name), name).toBe(true);
    }
  });

  it("excludes non-video files", () => {
    for (const name of ["a.jpg", "a.pdf", "a.mp3", "a"]) {
      expect(isVideoFile(name), name).toBe(false);
    }
  });

  // Everything inline-playable is a video file; the reverse does not hold. If that inverts, the
  // thumbnail would offer a player for something the viewer refuses to open.
  it("is a superset of the inline-playable set", () => {
    for (const name of ["a.mp4", "a.webm", "a.mov", "a.m4v"]) {
      expect(isInlineVideo(name) && isVideoFile(name), name).toBe(true);
    }
  });
});
