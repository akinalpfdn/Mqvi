import { describe, it, expect, vi, beforeEach } from "vitest";

const env = vi.hoisted(() => ({ electron: false, capacitor: false, capPlatform: "web" }));

vi.mock("./constants", () => ({
  isElectron: () => env.electron,
  isCapacitor: () => env.capacitor,
  getCapacitorPlatform: () => env.capPlatform,
}));

import { clientPlatform, clientDeviceLabel } from "./clientPlatform";

beforeEach(() => {
  env.electron = false;
  env.capacitor = false;
  env.capPlatform = "web";
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe("clientPlatform", () => {
  it.each([
    ["win32", "windows"],
    ["darwin", "macos"],
    ["linux", "linux"],
  ])("should report the desktop OS when Electron runs on %s", (host, want) => {
    env.electron = true;
    (window as { electronAPI?: unknown }).electronAPI = { platform: host };

    expect(clientPlatform()).toBe(want);
  });

  it("should report the phone OS in the mobile app", () => {
    env.capacitor = true;
    env.capPlatform = "android";

    expect(clientPlatform()).toBe("android");
  });

  it("should report web in a browser", () => {
    expect(clientPlatform()).toBe("web");
  });
});

describe("clientDeviceLabel", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0", "Edge"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 OPR/115.0", "Opera"],
    ["Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", "Chrome"],
    ["Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", "Safari"],
    ["curl/8.0", "browser"],
  ])("should name the browser for %s", (ua, want) => {
    expect(clientDeviceLabel(ua)).toBe(want);
  });

  it("should label the apps instead of the browser engine inside them", () => {
    env.electron = true;
    expect(clientDeviceLabel()).toBe("desktop");
    env.electron = false;
    env.capacitor = true;
    expect(clientDeviceLabel()).toBe("mobile");
  });
});
