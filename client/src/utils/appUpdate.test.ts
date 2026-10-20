/** The update prompt: forced below the server's minimum, optional for a newer store version. */
import { describe, it, expect } from "vitest";
import { compareVersions, decideUpdate } from "./appUpdate";

describe("compareVersions", () => {
  it.each([
    ["1.1.0", "1.1.0", 0],
    ["1.1", "1.1.0", 0],
    ["1.10.0", "1.9.9", 1],
    ["1.0.9", "1.1.0", -1],
    ["2", "1.99.99", 1],
  ])("%s vs %s is %i", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
  });
});

describe("decideUpdate", () => {
  const facts = { current: "1.1.0", minimum: "", store: null, dismissedId: null };
  const play = { id: "9", name: null };
  const appStore = (name: string) => ({ id: name, name });

  it("asks nothing when up to date and no minimum", () => {
    expect(decideUpdate(facts)).toEqual({ kind: "none" });
  });

  it("requires an update below the minimum when Play offers one", () => {
    expect(decideUpdate({ ...facts, minimum: "1.2.0", store: play })).toEqual({ kind: "required" });
  });

  it("requires an update below the minimum when the App Store version meets it", () => {
    expect(decideUpdate({ ...facts, minimum: "1.2.0", store: appStore("1.2.0") })).toEqual({ kind: "required" });
  });

  it("does not lock out when the store has nothing that meets the minimum", () => {
    expect(decideUpdate({ ...facts, minimum: "1.3.0", store: appStore("1.2.0") })).toEqual({ kind: "available", id: "1.2.0" });
  });

  it("does not lock out when the store has nothing new at all", () => {
    expect(decideUpdate({ ...facts, minimum: "9.0.0" })).toEqual({ kind: "none" });
  });

  it("does not require one at or above the minimum", () => {
    expect(decideUpdate({ ...facts, minimum: "1.1.0", store: play })).toEqual({ kind: "available", id: "9" });
  });

  it("does not offer the store version the user put off", () => {
    expect(decideUpdate({ ...facts, store: play, dismissedId: "9" })).toEqual({ kind: "none" });
  });

  it("offers the next store version after one was put off", () => {
    expect(decideUpdate({ ...facts, store: { id: "10", name: null }, dismissedId: "9" })).toEqual({ kind: "available", id: "10" });
  });

  it("forces the update even when its store version was put off", () => {
    expect(decideUpdate({ ...facts, minimum: "1.2.0", store: play, dismissedId: "9" })).toEqual({ kind: "required" });
  });
});
