/** Where "download" sends each visitor. */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("./constants", () => ({ isNativeApp: () => false }));

import { detectOS, APP_STORE_URL, PLAY_STORE_URL } from "./detectOS";

function visit(userAgent: string, maxTouchPoints = 0) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  // jsdom has no maxTouchPoints.
  Object.defineProperty(navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
}

afterEach(() => vi.restoreAllMocks());

describe("the download link", () => {
  it("sends an iPhone to the App Store", () => {
    visit("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148");
    expect(detectOS()).toMatchObject({ os: "ios", url: APP_STORE_URL });
  });

  it("sends an iPad asking for the desktop site to the App Store", () => {
    visit("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5);
    expect(detectOS()).toMatchObject({ os: "ios", url: APP_STORE_URL });
  });

  it("sends an Android phone to Google Play", () => {
    visit("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36");
    expect(detectOS()).toMatchObject({ os: "android", url: PLAY_STORE_URL });
  });

  it("keeps a Mac on the macOS installer", () => {
    visit("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36");
    expect(detectOS().os).toBe("macos");
  });

  it("keeps desktop Linux on the AppImage, not Google Play", () => {
    visit("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36");
    expect(detectOS().os).toBe("linux");
  });
});
