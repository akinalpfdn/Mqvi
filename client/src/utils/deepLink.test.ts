import { describe, it, expect } from "vitest";
import { deepLinkPath } from "./deepLink";

describe("deepLinkPath", () => {
  it("should open the invite route when an invite link is tapped", () => {
    expect(deepLinkPath("https://mqvi.net/invite/aB3xY9")).toBe("/invite/aB3xY9");
  });

  it("should open the channel route when a channel link is tapped", () => {
    expect(deepLinkPath("https://mqvi.net/channels/12/34")).toBe("/channels/12/34");
    expect(deepLinkPath("https://mqvi.net/channels")).toBe("/channels");
  });

  it("should keep the query string when the link carries one", () => {
    expect(deepLinkPath("https://mqvi.net/channels/12/34?msg=99")).toBe("/channels/12/34?msg=99");
  });

  it("should stay in the browser for pages the app does not render", () => {
    // Someone without the app has to be able to reach these — and Google opens /privacy and
    // /delete-account in a browser while reviewing the Play listing.
    expect(deepLinkPath("https://mqvi.net/")).toBeNull();
    expect(deepLinkPath("https://mqvi.net/login")).toBeNull();
    expect(deepLinkPath("https://mqvi.net/privacy")).toBeNull();
    expect(deepLinkPath("https://mqvi.net/delete-account")).toBeNull();
  });

  it("should reject a path that merely starts like one we handle", () => {
    expect(deepLinkPath("https://mqvi.net/channelsomething")).toBeNull();
    expect(deepLinkPath("https://mqvi.net/invite/")).toBeNull();
  });

  it("should reject another host", () => {
    expect(deepLinkPath("https://evil.example/invite/abc")).toBeNull();
    expect(deepLinkPath("https://mqvi.net.evil.example/invite/abc")).toBeNull();
  });

  it("should reject a non-https scheme", () => {
    // The manifest only claims https, but the URL reaching the handler is attacker-shaped input
    // either way: it must never be handed to the router as-is.
    expect(deepLinkPath("javascript:alert(1)")).toBeNull();
    expect(deepLinkPath("http://mqvi.net/invite/abc")).toBeNull();
    expect(deepLinkPath("file:///etc/passwd")).toBeNull();
  });

  it("should reject garbage that is not a URL", () => {
    expect(deepLinkPath("")).toBeNull();
    expect(deepLinkPath("not a url")).toBeNull();
  });

  it("should normalise traversal rather than pass it through", () => {
    // URL parsing collapses ".." before we see it, so this lands outside the claimed routes.
    expect(deepLinkPath("https://mqvi.net/channels/../login")).toBeNull();
  });
});
