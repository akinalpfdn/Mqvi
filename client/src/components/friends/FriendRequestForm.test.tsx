/** A refused friend request is explained kindly; the server's own wording never reaches the user. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const sendRequest = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: { username?: string }) => (opts?.username ? `${key}:${opts.username}` : key) }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../stores/friendStore", () => ({
  useFriendStore: (select: (s: { sendRequest: typeof sendRequest }) => unknown) => select({ sendRequest }),
}));

import FriendRequestForm from "./FriendRequestForm";

async function send(username: string) {
  render(<FriendRequestForm />);
  fireEvent.change(screen.getByPlaceholderText("addFriendPlaceholder"), { target: { value: username } });
  await act(async () => {
    fireEvent.submit(screen.getByPlaceholderText("addFriendPlaceholder").closest("form") as HTMLFormElement);
  });
}

beforeEach(() => sendRequest.mockReset());

describe("sending a friend request", () => {
  it.each([
    ["friend_user_not_found", "friendErrorNotFound:dsfsdf"],
    ["friend_self", "friendErrorSelf:dsfsdf"],
    ["friend_already_friends", "friendErrorAlreadyFriends:dsfsdf"],
    ["friend_request_pending", "friendErrorPending:dsfsdf"],
    ["friend_invalid_username", "friendErrorInvalid:dsfsdf"],
  ])("words the %s refusal kindly", async (code, text) => {
    sendRequest.mockResolvedValue({ success: false, code });
    await send("dsfsdf");
    expect(screen.getByRole("status").textContent).toBe(text);
  });

  it("falls back to a gentle retry for anything unexpected, never the server's text", async () => {
    sendRequest.mockResolvedValue({ success: false, code: undefined });
    await send("dsfsdf");
    expect(screen.getByRole("status").textContent).toBe("friendErrorGeneric:dsfsdf");
  });

  it("confirms a sent request", async () => {
    sendRequest.mockResolvedValue({ success: true });
    await send("bob");
    expect(screen.getByRole("status").textContent).toBe("friendRequestSent:bob");
  });
});
