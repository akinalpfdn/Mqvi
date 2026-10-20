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
  const facts = { current: "1.1.0", minimum: "", storeVersionId: null, dismissedId: null };

  it("asks nothing when up to date and no minimum", () => {
    expect(decideUpdate(facts)).toEqual({ kind: "none" });
  });

  it("requires an update below the server's minimum, even with nothing new in the store", () => {
    expect(decideUpdate({ ...facts, minimum: "1.2.0" })).toEqual({ kind: "required" });
  });

  it("does not require one at or above the minimum", () => {
    expect(decideUpdate({ ...facts, minimum: "1.1.0" })).toEqual({ kind: "none" });
  });

  it("offers a newer store version", () => {
    expect(decideUpdate({ ...facts, storeVersionId: "9" })).toEqual({ kind: "available", id: "9" });
  });

  it("does not offer the store version the user put off", () => {
    expect(decideUpdate({ ...facts, storeVersionId: "9", dismissedId: "9" })).toEqual({ kind: "none" });
  });

  it("offers the next store version after one was put off", () => {
    expect(decideUpdate({ ...facts, storeVersionId: "10", dismissedId: "9" })).toEqual({ kind: "available", id: "10" });
  });

  it("forces the update even when its store version was put off", () => {
    expect(decideUpdate({ ...facts, minimum: "1.2.0", storeVersionId: "9", dismissedId: "9" })).toEqual({ kind: "required" });
  });
});
