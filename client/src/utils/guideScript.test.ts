/** What the guide says, given what the user has done. */
import { describe, it, expect } from "vitest";

import { guideConversation } from "./guideScript";

const none = { community: false, message: false, dm: false, voice: false, friend: false, profile: false, roles: false, app: false };

const cards = (steps: typeof none) =>
  guideConversation(steps).flatMap((item) => (item.kind === "card" ? [[item.step, item.done]] : []));

describe("the guide conversation", () => {
  it("greets a new user and offers every step at once", () => {
    const items = guideConversation(none);
    expect(items[0]).toMatchObject({ kind: "message", textKey: "greeting" });
    expect(cards(none).map(([step]) => step)).toEqual(["community", "message", "dm", "voice", "friend", "profile", "roles", "app"]);
    expect(cards(none).every(([, done]) => done === false)).toBe(true);
  });

  it("ticks each step on its own, in whatever order it was done", () => {
    const done = cards({ ...none, friend: true, voice: true }).filter(([, d]) => d).map(([step]) => step);
    expect(done).toEqual(["voice", "friend"]);
  });

  it("closes with a finale only when every step is done", () => {
    const all = { community: true, message: true, dm: true, voice: true, friend: true, profile: true, roles: true, app: true };
    expect(guideConversation(all).at(-1)).toMatchObject({ kind: "message", textKey: "finale" });
    expect(guideConversation({ ...all, voice: false }).some((item) => item.id === "finale")).toBe(false);
  });

  it("never repeats an id, so lines already seen stay recognisable", () => {
    const all = { community: true, message: true, dm: true, voice: true, friend: true, profile: true, roles: true, app: true };
    const ids = guideConversation(all).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
