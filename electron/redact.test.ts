import { describe, it, expect } from "vitest";
import { createRedactor } from "./redact";

// The helper's last output line is attached to the fallback report, which lands in app_logs and
// gets screenshotted. The helper is handed a LiveKit token and the room's E2EE passphrase on
// stdin. These pin the one rule: neither value survives the trip, whatever else changes about the
// output.

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJ2aWRlbyI6e319.c2lnbmF0dXJl";
const PASSPHRASE = "kZ8vQ2nR7tX1wY4pL6mB9cD3fG5hJ0sA2eU8iO4qT7k";

describe("createRedactor", () => {
  it("should remove a token that a log line printed in full", () => {
    const redact = createRedactor([TOKEN, PASSPHRASE]);

    const out = redact(`connecting with token=${TOKEN} to wss://lk.example`);

    expect(out).not.toContain(TOKEN);
    expect(out).toContain("[redacted]");
    // The rest of the line survives — the point is to keep the message readable, not to drop it.
    expect(out).toContain("wss://lk.example");
  });

  it("should remove the passphrase", () => {
    const redact = createRedactor([TOKEN, PASSPHRASE]);

    expect(redact(`e2ee key ${PASSPHRASE} installed`)).not.toContain(PASSPHRASE);
  });

  it("should remove every occurrence, not just the first", () => {
    const redact = createRedactor([TOKEN]);

    const out = redact(`${TOKEN} ... retrying with ${TOKEN}`);

    expect(out).not.toContain(TOKEN);
    expect(out.match(/\[redacted]/g)).toHaveLength(2);
  });

  // If one secret is a substring of another, replacing the short one first leaves a mangled tail of
  // the long one on the line — still secret, still published.
  it("should not leave a tail when one secret contains another", () => {
    const long = "supersecret-with-a-long-tail";
    const short = "supersecret";
    const redact = createRedactor([short, long]);

    const out = redact(`value=${long}`);

    expect(out).toBe("value=[redacted]");
    expect(out).not.toContain("with-a-long-tail");
  });

  it("should leave a line alone when it holds no secret", () => {
    const redact = createRedactor([TOKEN, PASSPHRASE]);
    const line = "Error: no hardware encoder MFT available for this codec";

    expect(redact(line)).toBe(line);
  });

  // The synthetic/test paths start the helper with no token at all. An empty string must not turn
  // into a redactor that matches everywhere.
  it("should ignore empty and missing secrets", () => {
    const redact = createRedactor(["", undefined, TOKEN]);

    expect(redact("fed=30 sent=30")).toBe("fed=30 sent=30");
    expect(redact(`t=${TOKEN}`)).toBe("t=[redacted]");
  });

  it("should be a no-op when there is nothing to redact", () => {
    const redact = createRedactor([undefined, ""]);

    expect(redact("anything at all")).toBe("anything at all");
  });
});
