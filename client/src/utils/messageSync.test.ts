import { describe, it, expect } from "vitest";
import { mergeLatestPage } from "./messageSync";

type Msg = { id: string };

const msgs = (...ids: string[]): Msg[] => ids.map((id) => ({ id }));

describe("mergeLatestPage", () => {
  it("should keep scrollback when the refetched page overlaps what is held", () => {
    const { messages, replaced } = mergeLatestPage(msgs("1", "2", "3", "4"), msgs("3", "4", "5", "6"));

    expect(messages.map((m) => m.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(replaced).toBe(false);
  });

  it("should drop the held window when the page does not reach back to it", () => {
    // More than a page arrived while the socket was down, so anything held now sits across a
    // gap — keeping it would splice unrelated messages together with nothing in between.
    const { messages, replaced } = mergeLatestPage(msgs("1", "2"), msgs("90", "91"));

    expect(messages.map((m) => m.id)).toEqual(["90", "91"]);
    expect(replaced).toBe(true);
  });

  it("should not duplicate messages the socket already delivered", () => {
    const { messages } = mergeLatestPage(msgs("1", "2", "3"), msgs("2", "3"));

    expect(messages.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("should prefer the server's copy of a message it already holds", () => {
    const { messages } = mergeLatestPage(
      [{ id: "1", content: "stale" }],
      [{ id: "1", content: "edited" }]
    );

    expect(messages).toEqual([{ id: "1", content: "edited" }]);
  });

  it("should take the page when nothing is held", () => {
    const { messages, replaced } = mergeLatestPage([], msgs("1", "2"));

    expect(messages.map((m) => m.id)).toEqual(["1", "2"]);
    expect(replaced).toBe(true);
  });

  it("should keep what is held when the page is empty", () => {
    const { messages, replaced } = mergeLatestPage(msgs("1"), []);

    expect(messages.map((m) => m.id)).toEqual(["1"]);
    expect(replaced).toBe(false);
  });
});
