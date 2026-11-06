import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Role } from "../types";

vi.mock("../api/roles", () => ({}));

import { useRoleStore } from "./roleStore";

function role(id: string, position: number): Role {
  return { id, position, name: id } as Role; // only the fields the store reads
}

beforeEach(() => {
  useRoleStore.setState({ rolesByServer: {} });
});

// role_create now reaches every member of the server, including ones who never opened its roles.
describe("handleRoleCreate", () => {
  it("should not start a list for a server whose roles were never fetched", () => {
    useRoleStore.getState().handleRoleCreate("srv", role("new", 5));

    expect(useRoleStore.getState().rolesByServer["srv"]).toBeUndefined();
  });

  it("should add the role to a fetched list, highest position first", () => {
    useRoleStore.setState({ rolesByServer: { srv: [role("a", 10), role("b", 1)] } });

    useRoleStore.getState().handleRoleCreate("srv", role("new", 5));

    expect(useRoleStore.getState().rolesByServer["srv"].map((r) => r.id)).toEqual(["a", "new", "b"]);
  });

  it("should not add a role twice", () => {
    useRoleStore.setState({ rolesByServer: { srv: [role("a", 10)] } });

    useRoleStore.getState().handleRoleCreate("srv", role("a", 10));

    expect(useRoleStore.getState().rolesByServer["srv"]).toHaveLength(1);
  });
});
