/** A pending send is drawn under the stored messages, and its delivery line offers what can be done. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ChatContextValue, ChatMessage } from "../../hooks/useChatContext";
import type { PendingMessage } from "../../stores/outboxStore";
import type { User } from "../../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// The row itself is not under test here; what MessageList hands it is.
vi.mock("./Message", () => ({
  default: ({ message, pending }: { message: ChatMessage; pending?: PendingMessage }) => (
    <div data-testid="row" data-pending={pending ? pending.status : ""}>{message.content}</div>
  ),
}));

const { ChatContext } = await import("../../hooks/useChatContext");
const { default: MessageList } = await import("./MessageList");
const { default: PendingMessageStatus } = await import("./PendingMessageStatus");
const { useOutboxStore, resetOutbox } = await import("../../stores/outboxStore");
const { useAuthStore } = await import("../../stores/authStore");

const me = { id: "me", username: "me" } as User;
const retryPending = vi.fn();
const discardPending = vi.fn();

function contextValue(messages: ChatMessage[], isLoading = false): ChatContextValue {
  // Only the fields MessageList and PendingMessageStatus read; the rest is never touched.
  return {
    mode: "channel", channelId: "c1", channelName: "general", messages,
    isLoading, isLoadingMore: false, hasMore: false, scrollToMessageId: null,
    fetchMessages: vi.fn(async () => {}), fetchOlderMessages: vi.fn(async () => {}),
    setScrollToMessageId: vi.fn(), retryPending, discardPending,
  } as unknown as ChatContextValue;
}

const pendingEntry = (nonce: string, content: string, status: PendingMessage["status"] = "sending"): PendingMessage => ({
  nonce, kind: "channel", conversationId: "c1", serverId: "s1", content, files: [], attachments: [],
  replyToId: null, referencedMessage: null, createdAt: "2026-10-21T10:00:00Z", status,
  failure: status === "failed" ? "transient" : null,
});

beforeEach(() => {
  resetOutbox();
  vi.clearAllMocks();
  useAuthStore.setState({ user: me });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as never;
});

describe("MessageList with pending sends", () => {
  it("should draw pending messages under the stored ones, marked as pending", () => {
    useOutboxStore.getState().add(pendingEntry("n1", "on its way"));
    const storedMsg = { id: "m1", user_id: "bob", content: "stored", created_at: "2026-10-21T09:00:00Z", author: { id: "bob" } } as ChatMessage;

    render(
      <ChatContext.Provider value={contextValue([storedMsg])}>
        <MessageList />
      </ChatContext.Provider>
    );

    const rows = screen.getAllByTestId("row");
    expect(rows.map((r) => r.textContent)).toEqual(["stored", "on its way"]);
    expect(rows.map((r) => r.dataset.pending)).toEqual(["", "sending"]);
  });
});

describe("MessageList while loading", () => {
  const storedMsg = { id: "m1", user_id: "bob", content: "held", created_at: "2026-10-21T09:00:00Z", author: { id: "bob" } } as ChatMessage;

  it("should keep the messages a conversation holds on screen instead of a skeleton", () => {
    render(
      <ChatContext.Provider value={contextValue([storedMsg], true)}>
        <MessageList />
      </ChatContext.Provider>
    );

    expect(screen.getAllByTestId("row").map((r) => r.textContent)).toEqual(["held"]);
  });

  it("should show the skeleton for a conversation with nothing to show yet", () => {
    render(
      <ChatContext.Provider value={contextValue([], true)}>
        <MessageList />
      </ChatContext.Provider>
    );

    expect(screen.queryAllByTestId("row")).toEqual([]);
    expect(screen.queryByText("welcomeChannel")).toBeNull();
  });
});

describe("PendingMessageStatus", () => {
  function renderStatus(entry: PendingMessage) {
    return render(
      <ChatContext.Provider value={contextValue([])}>
        <PendingMessageStatus pending={entry} />
      </ChatContext.Provider>
    );
  }

  it("should offer retry and delete on a failed send", () => {
    renderStatus(pendingEntry("n1", "x", "failed"));

    fireEvent.click(screen.getByText("retrySend"));
    fireEvent.click(screen.getByText("discardMessage"));

    expect(retryPending).toHaveBeenCalledWith("n1");
    expect(discardPending).toHaveBeenCalledWith("n1");
  });

  it("should show upload progress with a cancel that drops the message", () => {
    useOutboxStore.getState().setProgress("n1", { loaded: 50, total: 100 });
    renderStatus(pendingEntry("n1", "x"));

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    fireEvent.click(screen.getByLabelText("cancel"));
    expect(discardPending).toHaveBeenCalledWith("n1");
  });

  it("should say it is sending when there is no upload", () => {
    renderStatus(pendingEntry("n1", "x"));

    expect(screen.getByText("messageSending")).toBeTruthy();
  });
});
