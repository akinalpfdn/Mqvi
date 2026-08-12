/**
 * Mention tokens as readable text, for the places that show a message on one line.
 *
 * Message bodies go through `renderContent` in Message.tsx, which turns `<@id>` into a styled span.
 * The one-line previews — reply preview, pinned list, search results — printed `content` raw, so a
 * message that mentioned someone showed `<@eb53a4c3ef218a18>` to the reader.
 *
 * They cannot just call `renderContent`: it also emits `<img>` for GIFs and `<a>` for links, which
 * breaks a single truncated line and puts a nested click target inside a row that is itself
 * clickable. Text is what a preview wants.
 *
 * Fallbacks match `renderContent` exactly (`@unknown-user`, `@unknown-role`) — a preview and the
 * message it previews must not disagree about who was mentioned.
 */

type MentionMember = { id: string; username: string; display_name: string | null };
type MentionRole = { id: string; name: string };

/** Same token shapes renderContent parses. Legacy bare `@name` needs no resolution — it is already
 *  readable — so it is deliberately not matched here. */
const MENTION_TOKEN = /<@&?[a-z0-9]+>/gi;

export function mentionsToText(
  text: string,
  members: readonly MentionMember[],
  roles: readonly MentionRole[]
): string {
  // Cheap out before building the lookup maps: most messages mention nobody.
  if (!text.includes("<@")) return text;

  const memberById = new Map(members.map((m) => [m.id, m.display_name ?? m.username]));
  const roleById = new Map(roles.map((r) => [r.id, r.name]));

  return text.replace(MENTION_TOKEN, (token) => {
    const role = token.match(/^<@&([a-z0-9]+)>$/i);
    if (role) return `@${roleById.get(role[1]) ?? "unknown-role"}`;

    const user = token.match(/^<@([a-z0-9]+)>$/i);
    if (user) return `@${memberById.get(user[1]) ?? "unknown-user"}`;

    return token;
  });
}
