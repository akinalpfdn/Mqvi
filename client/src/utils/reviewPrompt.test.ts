/** The review request: 10th open of a version, once per version, never while busy. */
import { describe, it, expect } from "vitest";
import { NEW_OPEN_AFTER_MS, REVIEW_AFTER_OPENS, recordBackground, recordForeground, shouldAskForReview, type ReviewRecord } from "./reviewPrompt";

const HOUR = 60 * 60 * 1000;

/** Opens the app `times` times, an hour apart. */
function openTimes(times: number, version = "1.1.0"): ReviewRecord {
  let record: ReviewRecord | null = null;
  for (let i = 0; i < times; i++) record = recordForeground(record, version, i * HOUR);
  return record as ReviewRecord;
}

describe("review prompt", () => {
  it("counts the first launch as the first open", () => {
    expect(recordForeground(null, "1.1.0", 0).opens).toBe(1);
  });

  it("asks on the 10th open, not before", () => {
    expect(shouldAskForReview(openTimes(REVIEW_AFTER_OPENS - 1), false)).toBe(false);
    expect(shouldAskForReview(openTimes(REVIEW_AFTER_OPENS), false)).toBe(true);
  });

  it("does not count a quick switch away and back", () => {
    const record = openTimes(3);
    const away = recordBackground(record, record.lastSeenAt + 1000);
    const back = recordForeground(away, "1.1.0", away.lastSeenAt + NEW_OPEN_AFTER_MS - 1);
    expect(back.opens).toBe(3);
  });

  it("counts coming back after half an hour away", () => {
    const record = openTimes(3);
    const away = recordBackground(record, record.lastSeenAt + 5 * HOUR); // used for five hours, then left
    const back = recordForeground(away, "1.1.0", away.lastSeenAt + NEW_OPEN_AFTER_MS);
    expect(back.opens).toBe(4);
  });

  it("waits while the user is in a call or voice channel", () => {
    expect(shouldAskForReview(openTimes(REVIEW_AFTER_OPENS), true)).toBe(false);
  });

  it("asks only once per version", () => {
    const asked = { ...openTimes(REVIEW_AFTER_OPENS + 5), asked: true };
    expect(shouldAskForReview(asked, false)).toBe(false);
  });

  it("starts over on a new version", () => {
    const asked = { ...openTimes(REVIEW_AFTER_OPENS), asked: true };
    const updated = recordForeground(asked, "1.2.0", asked.lastSeenAt + HOUR);
    expect(updated).toMatchObject({ version: "1.2.0", opens: 1, asked: false });
  });
});
