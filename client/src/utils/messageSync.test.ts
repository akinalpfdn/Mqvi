import { describe, it, expect } from "vitest";
import { mergeLatestPage } from "./messageSync";

type Msg = { id: string; created_at: string };

/** Message n was written at second n, so ids double as the order they were sent in. */
const at = (second: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, second)).toISOString();
const msgs = (...ids: string[]): Msg[] => ids.map((id) => ({ id, created_at: at(Number(id)) }));

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
      [{ id: "1", created_at: at(1), content: "stale" }],
      [{ id: "1", created_at: at(1), content: "edited" }]
    );

    expect(messages).toEqual([{ id: "1", created_at: at(1), content: "edited" }]);
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

  describe("messages deleted while the socket was down", () => {
    it("should drop one the page skips between messages it shares", () => {
      const { messages } = mergeLatestPage(msgs("1", "2", "3", "4"), msgs("2", "4", "5"));

      expect(messages.map((m) => m.id)).toEqual(["1", "2", "4", "5"]);
    });

    it("should drop the newest held one when the page has newer messages than it", () => {
      const { messages } = mergeLatestPage(msgs("1", "2", "3"), msgs("2", "4"));

      expect(messages.map((m) => m.id)).toEqual(["1", "2", "4"]);
    });

    it("should keep one that arrived over the socket after the page was read", () => {
      const { messages } = mergeLatestPage(msgs("1", "2", "6"), msgs("1", "2", "5"));

      // 5 was missed by the socket, 6 delivered by it: shown in the order they were sent.
      expect(messages.map((m) => m.id)).toEqual(["1", "2", "5", "6"]);
    });

    it("should keep one from the page's newest second, which may have come in after the read", () => {
      const held: Msg[] = [...msgs("1", "2"), { id: "late", created_at: at(3) }];
      const { messages } = mergeLatestPage(held, msgs("1", "2", "3"));

      expect(messages.map((m) => m.id).sort()).toEqual(["1", "2", "3", "late"]);
    });

    it("should keep scrollback older than the page, which the page says nothing about", () => {
      const { messages } = mergeLatestPage(msgs("1", "2", "3", "4"), msgs("3", "4"));

      expect(messages.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
    });
  });
});
