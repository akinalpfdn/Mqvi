import { createContext, useContext, type ReactNode } from "react";
import type { UserStatus } from "../types";

type ChatCommandActions = {
  sendPresenceUpdate: (status: UserStatus) => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
};

const ChatCommandActionsContext = createContext<ChatCommandActions | null>(null);

export function ChatCommandActionsProvider({
  value,
  children,
}: {
  value: ChatCommandActions;
  children: ReactNode;
}) {
  return (
    <ChatCommandActionsContext.Provider value={value}>
      {children}
    </ChatCommandActionsContext.Provider>
  );
}

export function useChatCommandActions(): ChatCommandActions {
  const value = useContext(ChatCommandActionsContext);
  if (!value) {
    throw new Error("useChatCommandActions must be used within ChatCommandActionsProvider");
  }
  return value;
}
