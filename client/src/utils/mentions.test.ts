/**
 * Mention tokens in one-line previews.
 *
 * The bug this pins: the reply preview, the pinned list and the search results printed `content`
 * raw, so a reply to a message that mentioned someone showed `<@eb53a4c3ef218a18>` — the reader
 * saw an id where the message body two lines below showed a name.
 *
 * The fallbacks matter as much as the happy path. A preview that says `@unknown-user` where the
 * body says `@alice` is a different kind of wrong: it tells the reader the mention is broken.
 */
import { describe, it, expect } from "vitest";
import { mentionsToText } from "./mentions";

const members = [
  { id: "eb53a4c3ef218a18", username: "codignia", display_name: "codignia" },
  { id: "aa11", username: "matt", display_name: "Matt Dün" },
  { id: "bb22", username: "nodisplay", display_name: null },
];

const roles = [
  { id: "r1", name: "HIVE ARCHITECT" },
  { id: "r2", name: "moderator" },
];

describe("mentionsToText", () => {
  it("should replace a user token with the display name", () => {
    expect(mentionsToText("Hi <@eb53a4c3ef218a18>, I have a question.", members, roles)).toBe(
      "Hi @codignia, I have a question."
    );
  });

  it("should fall back to the username when there is no display name", () => {
    expect(mentionsToText("<@bb22> hello", members, roles)).toBe("@nodisplay hello");
  });

  it("should replace a role token with the role name", () => {
    expect(mentionsToText("ping <@&r1> please", members, roles)).toBe("ping @HIVE ARCHITECT please");
  });

  it("should replace every token in one message", () => {
    expect(mentionsToText("<@aa11> and <@&r2> and <@bb22>", members, roles)).toBe(
      "@Matt Dün and @moderator and @nodisplay"
    );
  });

  // Matching renderContent is the point: a preview and the body it previews must not disagree
  // about who was mentioned.
  it("should use the same fallbacks the message body uses", () => {
    expect(mentionsToText("<@ffff> <@&nope>", members, roles)).toBe("@unknown-user @unknown-role");
  });

  it("should leave a message with no tokens exactly as it was", () => {
    const text = "no mentions here, just an email a@b.com and a price of $5";
    expect(mentionsToText(text, members, roles)).toBe(text);
  });

  // Legacy bare @name predates tokens and is already readable — resolving it would be guesswork,
  // and renderContent only colours it, never rewrites it.
  it("should not touch a legacy bare @name", () => {
    expect(mentionsToText("@codignia said so", members, roles)).toBe("@codignia said so");
  });

  it("should not mangle text that merely looks like a token", () => {
    expect(mentionsToText("use <@ or @> carefully", members, roles)).toBe("use <@ or @> carefully");
  });

  it("should survive an empty roster", () => {
    expect(mentionsToText("<@aa11>", [], [])).toBe("@unknown-user");
  });
});
