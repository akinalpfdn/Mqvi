import { describe, it, expect } from "vitest";
import { selectServerE2EE, toServerListItem } from "./serverStore";
import type { Server, ServerListItem } from "../types";

/**
 * `undefined` means "not known yet", and every caller has to treat it as such. Reporting `false` for
 * a server the client has not heard of sent plaintext to a server that mandates encryption — a deep
 * link opened before the list loads is enough, and so is a server too old to send the field.
 */
function state(servers: ServerListItem[], activeServer?: Server) {
  return { servers, activeServer } as unknown as Parameters<ReturnType<typeof selectServerE2EE>>[0];
}

const listItem = (id: string, e2ee: boolean | undefined): ServerListItem => ({
  id,
  name: id,
  icon_url: null,
  verified: false,
  e2ee_enabled: e2ee,
});

describe("selectServerE2EE", () => {
  it("reports the flag for a server in the list", () => {
    const s = state([listItem("s1", true), listItem("s2", false)]);
    expect(selectServerE2EE("s1")(s)).toBe(true);
    expect(selectServerE2EE("s2")(s)).toBe(false);
  });

  it("prefers the active server, which is the freshest copy", () => {
    const s = state([listItem("s1", false)], { id: "s1", e2ee_enabled: true } as Server);
    expect(selectServerE2EE("s1")(s)).toBe(true);
  });

  it("returns undefined for a server it has never heard of", () => {
    expect(selectServerE2EE("unknown")(state([listItem("s1", true)]))).toBeUndefined();
  });

  it("returns undefined when no server is named at all", () => {
    expect(selectServerE2EE(null)(state([]))).toBeUndefined();
    expect(selectServerE2EE(undefined)(state([]))).toBeUndefined();
  });

  // A server older than this client does not send the field. Absent is unknown, not "off" — reading
  // it as off is what puts a plaintext message on an encrypted server.
  it("returns undefined when the server omitted the field", () => {
    expect(selectServerE2EE("s1")(state([listItem("s1", undefined)]))).toBeUndefined();
  });
});

describe("toServerListItem", () => {
  // Six hand-written literals used to build this shape and each dropped a field, so a rename or an
  // encryption toggle left the entry claiming the server was unencrypted.
  it("carries every field the list entry declares", () => {
    const server = {
      id: "s1",
      name: "Alpha",
      icon_url: "/icon.png",
      verified: true,
      e2ee_enabled: true,
    } as Server;

    const item = toServerListItem(server);

    expect(item).toEqual({
      id: "s1",
      name: "Alpha",
      icon_url: "/icon.png",
      verified: true,
      e2ee_enabled: true,
    });
  });
});
