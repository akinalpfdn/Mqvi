import { describe, it, expect } from "vitest";
import { isStartFailureWorthReporting } from "./shareStartFailure";

// A cancelled share is the user's choice and must not reach the operator's log; a share that could
// not start is exactly what the log is for — on the desktop, the web and the phone alike.

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** What a Capacitor plugin's call.reject(message, code) arrives as. */
function pluginError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {});
}

describe("isStartFailureWorthReporting", () => {
  it("should report a desktop share whose source was picked", () => {
    expect(isStartFailureWorthReporting({ platform: "electron", pickedShareSourceId: "screen:1:0", err: domError("AbortError") })).toBe(true);
  });

  it("should not report a desktop picker that was cancelled", () => {
    expect(isStartFailureWorthReporting({ platform: "electron", pickedShareSourceId: null, err: domError("NotAllowedError") })).toBe(false);
  });

  it("should report a web share the browser could not capture", () => {
    expect(isStartFailureWorthReporting({ platform: "web", pickedShareSourceId: null, err: domError("NotReadableError") })).toBe(true);
  });

  it("should not report a web share whose browser picker was dismissed", () => {
    expect(isStartFailureWorthReporting({ platform: "web", pickedShareSourceId: null, err: domError("NotAllowedError") })).toBe(false);
  });

  it("should report a web failure that is not even an Error", () => {
    expect(isStartFailureWorthReporting({ platform: "web", pickedShareSourceId: null, err: "boom" })).toBe(true);
  });

  // The false alarm this guards against: every Android user who said no to the capture prompt
  // wrote a Warn row, under the browser engine's name.
  it("should not report a phone user declining the screen-capture prompt", () => {
    const declined = pluginError("Screen capture permission denied", "PERMISSION_DENIED");
    expect(isStartFailureWorthReporting({ platform: "mobile", pickedShareSourceId: null, err: declined })).toBe(false);
  });

  it("should report a phone share that failed to start", () => {
    const failed = pluginError("Failed to start screen share: connect timed out");
    expect(isStartFailureWorthReporting({ platform: "mobile", pickedShareSourceId: null, err: failed })).toBe(true);
  });
});
