/** A pending send is drawn under the stored messages, and its delivery line offers what can be done. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("MessageList auto-scroll", () => {
  // jsdom lays nothing out: give the scroller a height that grows with its rows (100px each), and
  // a scrollTop that sticks, so "scrolled to the bottom" can be measured.
  const tops = new WeakMap<Element, number>();
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() { return (this as HTMLElement).querySelectorAll("[data-testid=row]").length * 100; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() { return tops.get(this as Element) ?? 0; },
      set(v: number) { tops.set(this as Element, v); },
    });
  });
  afterEach(() => {
    for (const prop of ["scrollHeight", "clientHeight", "scrollTop"]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  });

  const row = (i: number) =>
    ({ id: `m${i}`, user_id: "bob", content: `msg ${i}`, created_at: `2026-10-22T10:00:${String(i).padStart(2, "0")}Z`, author: { id: "bob" } }) as ChatMessage;

  it("should follow new messages in a conversation that opened already holding some", () => {
    // Opened with its messages in place — from memory or the device cache, no loading state.
    const held = Array.from({ length: 10 }, (_, i) => row(i));
    const { rerender, container } = render(
      <ChatContext.Provider value={contextValue(held)}>
        <MessageList />
      </ChatContext.Provider>
    );

    rerender(
      <ChatContext.Provider value={contextValue([...held, row(10)])}>
        <MessageList />
      </ChatContext.Provider>
    );

    const scroller = container.querySelector(".messages-scroll") as HTMLElement;
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });
});

describe("MessageList row identity", () => {
  // Confirming a send must update its row in place. Deleted and re-inserted, the list was a row
  // shorter for a moment, and Safari (no scroll anchoring) left the view clamped one row short.
  it("should keep the same row element when a pending send is confirmed", () => {
    useOutboxStore.getState().add(pendingEntry("n1", "hello"));
    const { rerender, container } = render(
      <ChatContext.Provider value={contextValue([])}>
        <MessageList />
      </ChatContext.Provider>
    );
    const before = container.querySelector("#msg-pending-n1");

    const confirmed = { id: "m1", user_id: "me", content: "hello", created_at: "2026-10-22T10:00:00Z", author: me, client_nonce: "n1" } as ChatMessage;
    useOutboxStore.getState().remove("n1");
    rerender(
      <ChatContext.Provider value={contextValue([confirmed])}>
        <MessageList />
      </ChatContext.Provider>
    );

    expect(before).not.toBeNull();
    expect(container.querySelector("#msg-m1")).toBe(before);
  });
});

describe("MessageList pending and stored copies", () => {
  it("should draw a send once when its stored copy is already in the list", () => {
    useOutboxStore.getState().add(pendingEntry("n1", "hello"));
    const storedCopy = { id: "m1", user_id: "me", content: "hello", created_at: "2026-10-22T10:00:00Z", author: me, client_nonce: "n1" } as ChatMessage;

    render(
      <ChatContext.Provider value={contextValue([storedCopy])}>
        <MessageList />
      </ChatContext.Provider>
    );

    expect(screen.getAllByTestId("row").map((r) => r.textContent)).toEqual(["hello"]);
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

  it("should say the attachments were not kept, and offer no retry with no text to send", () => {
    renderStatus({ ...pendingEntry("n1", "", "failed"), filesLost: true });

    expect(screen.getByText("messageAttachmentsLost")).toBeTruthy();
    expect(screen.queryByText("retrySend")).toBeNull();
    expect(screen.getByText("discardMessage")).toBeTruthy();
  });

  it("should add no line of its own for a text send in flight — the clock on the message says it", () => {
    const { container } = renderStatus(pendingEntry("n1", "x"));

    expect(container.textContent).toBe("");
  });
});
