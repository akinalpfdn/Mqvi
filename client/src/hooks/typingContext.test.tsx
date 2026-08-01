/**
 * Typing changes on every keystroke anyone in the conversation makes. While it lived in
 * ChatContext, each of those minted a new context value and re-rendered every consumer of it —
 * including every loaded message row, none of which reads typing.
 *
 * This pins the separation itself, not a provider: it is the context wiring that regressed.
 */
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, act } from "@testing-library/react";

import {
  ChatContext,
  TypingProvider,
  useChatContext,
  useTypingUsers,
  type ChatContextValue,
} from "./useChatContext";

let chatRenders = 0;
let typingRenders = 0;

function MessageRowStandIn() {
  chatRenders++;
  const { channelName } = useChatContext();
  return <div>{channelName}</div>;
}

function TypingStandIn() {
  typingRenders++;
  const typing = useTypingUsers();
  return <div data-testid="typing">{typing.join(",")}</div>;
}

/**
 * Mirrors the real providers, and the structure matters: the typing subscription lives *inside*
 * the provider while `children` arrives as a prop from a parent that does not re-render. Building
 * the children inside the state-holding component instead would recreate their elements on every
 * keystroke and the test would blame the context for a re-render React caused on its own.
 */
let startTyping: () => void = () => {};

function ProviderWithTyping({
  stableValue,
  children,
}: {
  stableValue: ChatContextValue;
  children: React.ReactNode;
}) {
  const [typing, setTyping] = useState<string[]>([]);
  startTyping = () => setTyping(["ada"]);
  return (
    <ChatContext.Provider value={stableValue}>
      <TypingProvider value={typing}>{children}</TypingProvider>
    </ChatContext.Provider>
  );
}

describe("typing is separate from the message-bearing context", () => {
  it("should update the indicator without re-rendering ChatContext consumers", () => {
    chatRenders = 0;
    typingRenders = 0;

    // Deliberately the same object across renders — the real providers useMemo it, and the whole
    // point is that a typing event must not change it.
    const stableValue = { channelName: "general" } as unknown as ChatContextValue;

    render(
      <ProviderWithTyping stableValue={stableValue}>
        <MessageRowStandIn />
        <TypingStandIn />
      </ProviderWithTyping>
    );
    const chatRendersAfterMount = chatRenders;
    const typingRendersAfterMount = typingRenders;

    act(() => {
      startTyping();
    });

    expect(screen.getByTestId("typing").textContent).toBe("ada");
    expect(typingRenders).toBeGreaterThan(typingRendersAfterMount);
    // The assertion that matters: with typing back inside ChatContext this goes up too, once per
    // keystroke, multiplied by every message on screen.
    expect(chatRenders).toBe(chatRendersAfterMount);
  });
});
