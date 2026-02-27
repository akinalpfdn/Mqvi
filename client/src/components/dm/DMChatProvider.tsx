/**
 * DMChatProvider — DM store'unu ChatContext'e map'ler.
 *
 * useDMStore selector'larını tek bir ChatContextValue objesine dönüştürür.
 * DM'de roller ve kanal izinleri olmadığından:
 * - canSend: her zaman true
 * - canManageMessages: her zaman true (DM'de her iki kullanıcı da pin/delete yapabilir)
 * - showRoleColors: false
 * - members: boş array
 *
 * Kullanım:
 * <DMChatProvider channelId={id} channelName={name} sendDMTyping={fn}>
 *   <MessageList />
 *   <MessageInput />
 * </DMChatProvider>
 */

import { useMemo, useCallback, type ReactNode } from "react";
import { ChatContext, type ChatContextValue, type ChatMessage } from "../../hooks/useChatContext";
import { useDMStore } from "../../stores/dmStore";
import type { DMMessage, MemberWithRoles } from "../../types";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_MEMBERS: MemberWithRoles[] = [];
const EMPTY_STRINGS: string[] = [];

type DMChatProviderProps = {
  channelId: string;
  channelName: string;
  sendDMTyping: (dmChannelId: string) => void;
  children: ReactNode;
};

function DMChatProvider({
  channelId,
  channelName,
  sendDMTyping: sendDMTypingProp,
  children,
}: DMChatProviderProps) {
  // ─── Store selectors ───
  const messages = useDMStore(
    (s) => (channelId ? s.messagesByChannel[channelId] : undefined) as ChatMessage[] | undefined
  ) ?? EMPTY_MESSAGES;
  const isLoadingMessages = useDMStore((s) => s.isLoadingMessages);
  const hasMore = useDMStore((s) =>
    channelId ? s.hasMoreByChannel[channelId] ?? false : false
  );
  const replyingTo = useDMStore((s) => s.replyingTo) as ChatMessage | null;
  const scrollToMessageId = useDMStore((s) => s.scrollToMessageId);
  const typingUsers = useDMStore((s) =>
    channelId ? s.typingUsers[channelId] ?? EMPTY_STRINGS : EMPTY_STRINGS
  );

  const storeSetReplyingTo = useDMStore((s) => s.setReplyingTo);
  const storeSetScrollToMessageId = useDMStore((s) => s.setScrollToMessageId);
  const storeSendMessage = useDMStore((s) => s.sendMessage);
  const storeEditMessage = useDMStore((s) => s.editMessage);
  const storeDeleteMessage = useDMStore((s) => s.deleteMessage);
  const storeToggleReaction = useDMStore((s) => s.toggleReaction);
  const storeFetchMessages = useDMStore((s) => s.fetchMessages);
  const storeFetchOlderMessages = useDMStore((s) => s.fetchOlderMessages);
  const storePinMessage = useDMStore((s) => s.pinMessage);
  const storeUnpinMessage = useDMStore((s) => s.unpinMessage);

  // ─── Actions (stable refs) ───
  const sendMessage = useCallback(
    (content: string, files?: File[], replyToId?: string) =>
      storeSendMessage(channelId, content, files, replyToId),
    [channelId, storeSendMessage]
  );

  const editMessage = useCallback(
    (id: string, content: string) => storeEditMessage(id, content),
    [storeEditMessage]
  );

  const deleteMessage = useCallback(
    (id: string) => storeDeleteMessage(id),
    [storeDeleteMessage]
  );

  const fetchMessages = useCallback(
    () => storeFetchMessages(channelId),
    [channelId, storeFetchMessages]
  );

  const fetchOlderMessages = useCallback(
    () => storeFetchOlderMessages(channelId),
    [channelId, storeFetchOlderMessages]
  );

  const toggleReaction = useCallback(
    (messageId: string, emoji: string) =>
      storeToggleReaction(messageId, channelId, emoji),
    [channelId, storeToggleReaction]
  );

  const setReplyingTo = useCallback(
    (msg: ChatMessage | null) => {
      // ChatMessage → DMMessage cast: runtime'da bu obje zaten bir DMMessage,
      // ChatMessage olarak typed. Cast güvenli.
      storeSetReplyingTo(msg as DMMessage | null);
    },
    [storeSetReplyingTo]
  );

  const setScrollToMessageId = useCallback(
    (id: string | null) => storeSetScrollToMessageId(id),
    [storeSetScrollToMessageId]
  );

  const sendTyping = useCallback(
    () => sendDMTypingProp(channelId),
    [channelId, sendDMTypingProp]
  );

  const pinMessage = useCallback(
    async (messageId: string) => {
      await storePinMessage(channelId, messageId);
    },
    [channelId, storePinMessage]
  );

  const unpinMessage = useCallback(
    async (messageId: string) => {
      await storeUnpinMessage(channelId, messageId);
    },
    [channelId, storeUnpinMessage]
  );

  /**
   * isMessagePinned — DM'de ayrı pinStore yok, is_pinned doğrudan mesajda.
   * Messages array'inde ilgili mesajın is_pinned alanını kontrol eder.
   */
  const isMessagePinned = useCallback(
    (messageId: string) => {
      const msgs = useDMStore.getState().messagesByChannel[channelId];
      if (!msgs) return false;
      return msgs.some((m) => m.id === messageId && m.is_pinned);
    },
    [channelId]
  );

  // ─── Context Value (memoized) ───
  const value: ChatContextValue = useMemo(
    () => ({
      mode: "dm" as const,
      channelId,
      channelName,
      messages,
      isLoading: isLoadingMessages,
      isLoadingMore: false, // DM'de henüz isLoadingMore ayrı state yok
      hasMore,
      replyingTo,
      scrollToMessageId,
      typingUsers,
      sendMessage,
      editMessage,
      deleteMessage,
      fetchMessages,
      fetchOlderMessages,
      toggleReaction,
      setReplyingTo,
      setScrollToMessageId,
      sendTyping,
      pinMessage,
      unpinMessage,
      isMessagePinned,
      canSend: true,
      canManageMessages: true,
      showRoleColors: false,
      members: EMPTY_MEMBERS,
    }),
    [
      channelId, channelName, messages, isLoadingMessages, hasMore,
      replyingTo, scrollToMessageId, typingUsers,
      sendMessage, editMessage, deleteMessage, fetchMessages, fetchOlderMessages,
      toggleReaction, setReplyingTo, setScrollToMessageId, sendTyping,
      pinMessage, unpinMessage, isMessagePinned,
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export default DMChatProvider;
