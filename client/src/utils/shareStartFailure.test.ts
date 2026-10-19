import { describe, it, expect } from "vitest";
import { isStartFailureWorthReporting } from "./shareStartFailure";

// A cancelled share is the user's choice and must not reach the operator's log; a share that could
// not start is exactly what the log is for — on the web as much as in the desktop app.

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe("isStartFailureWorthReporting", () => {
  it("should report a desktop share whose source was picked", () => {
    expect(isStartFailureWorthReporting({ isElectronApp: true, pickedShareSourceId: "screen:1:0", err: domError("AbortError") })).toBe(true);
  });

  it("should not report a desktop picker that was cancelled", () => {
    expect(isStartFailureWorthReporting({ isElectronApp: true, pickedShareSourceId: null, err: domError("NotAllowedError") })).toBe(false);
  });

  it("should report a web share the browser could not capture", () => {
    expect(isStartFailureWorthReporting({ isElectronApp: false, pickedShareSourceId: null, err: domError("NotReadableError") })).toBe(true);
  });

  it("should not report a web share whose browser picker was dismissed", () => {
    expect(isStartFailureWorthReporting({ isElectronApp: false, pickedShareSourceId: null, err: domError("NotAllowedError") })).toBe(false);
  });

  it("should report a web failure that is not even an Error", () => {
    expect(isStartFailureWorthReporting({ isElectronApp: false, pickedShareSourceId: null, err: "boom" })).toBe(true);
  });
});
