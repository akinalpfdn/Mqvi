/** The composer after a send: never re-sends what already went out. */
import { describe, it, expect } from "vitest";
import { textLeftAfterSend } from "./composerText";

describe("textLeftAfterSend", () => {
  it("empties the box when nothing was typed during the send", () => {
    expect(textLeftAfterSend("long message", "long message")).toBe("");
  });

  it("keeps only what was typed after Enter, not the sent text again", () => {
    expect(textLeftAfterSend("long message xddd", "long message")).toBe("xddd");
  });

  it("drops the separator typed between the two", () => {
    expect(textLeftAfterSend("long message\n\nnext one", "long message")).toBe("next one");
  });

  it("keeps the box as it is when the sent part itself was edited during the send", () => {
    expect(textLeftAfterSend("long massage", "long message")).toBe("long massage");
  });

  it("keeps a box the user emptied during the send empty", () => {
    expect(textLeftAfterSend("", "long message")).toBe("");
  });
});
