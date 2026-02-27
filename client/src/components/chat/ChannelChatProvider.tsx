/**
 * ChannelChatProvider — Channel store'larını ChatContext'e map'ler.
 *
 * messageStore, pinStore, memberStore selector'larını tek bir
 * ChatContextValue objesine dönüştürür. Channel chat'in mevcut
 * davranışı aynen korunur — sadece veri akışı context üzerinden olur.
 *
 * Kullanım:
 * <ChannelChatProvider channelId={id} channelName={name} sendTyping={fn}>
 *   <MessageList />
 *   <MessageInput />
 * </ChannelChatProvider>
 */

import { useMemo, useCallback, useRef, type ReactNode } from "react";
import { ChatContext, type ChatContextValue, type ChatMessage } from "../../hooks/useChatContext";
import { useMessageStore } from "../../stores/messageStore";
import { usePinStore } from "../../stores/pinStore";
import { useMemberStore } from "../../stores/memberStore";
import { useAuthStore } from "../../stores/authStore";
import { useChannelPermissions } from "../../hooks/useChannelPermissions";
import { hasPermission, Permissions } from "../../utils/permissions";
import type { Message } from "../../types";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_STRINGS: string[] = [];

type ChannelChatProviderProps = {
  channelId: string;
  channelName: string;
  sendTyping: (channelId: string) => void;
  children: ReactNode;
};

function ChannelChatProvider({
  channelId,
  channelName,
  sendTyping: sendTypingProp,
  children,
}: ChannelChatProviderProps) {
  // ─── Store selectors ───
  const messages = useMessageStore(
    (s) => (channelId ? s.messagesByChannel[channelId] : undefined) as ChatMessage[] | undefined
  ) ?? EMPTY_MESSAGES;
  const isLoading = useMessageStore((s) => s.isLoading);
  const isLoadingMore = useMessageStore((s) => s.isLoadingMore);
  const hasMore = useMessageStore((s) =>
    channelId ? s.hasMoreByChannel[channelId] ?? false : false
  );
  const replyingTo = useMessageStore((s) => s.replyingTo) as ChatMessage | null;
  const scrollToMessageId = useMessageStore((s) => s.scrollToMessageId);
  const typingUsers = useMessageStore((s) =>
    channelId ? s.typingUsers[channelId] ?? EMPTY_STRINGS : EMPTY_STRINGS
  );

  const storeSetReplyingTo = useMessageStore((s) => s.setReplyingTo);
  const storeSetScrollToMessageId = useMessageStore((s) => s.setScrollToMessageId);
  const storeSendMessage = useMessageStore((s) => s.sendMessage);
  const storeEditMessage = useMessageStore((s) => s.editMessage);
  const storeDeleteMessage = useMessageStore((s) => s.deleteMessage);
  const storeToggleReaction = useMessageStore((s) => s.toggleReaction);
  const storeFetchMessages = useMessageStore((s) => s.fetchMessages);
  const storeFetchOlderMessages = useMessageStore((s) => s.fetchOlderMessages);

  const pinAction = usePinStore((s) => s.pin);
  const unpinAction = usePinStore((s) => s.unpin);
  const storeIsMessagePinned = usePinStore((s) => s.isMessagePinned);

  const members = useMemberStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);
  const { hasChannelPerm } = useChannelPermissions(channelId);

  // ─── File drop ref — ChatArea drag-drop'tan MessageInput'a dosya iletimi ───
  const addFilesRef = useRef<((files: File[]) => void) | null>(null);

  // ─── Permission hesaplama ───
  const canSend = hasChannelPerm(Permissions.SendMessages);
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageMessages = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageMessages)
    : false;

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
      // ChatMessage → Message cast: runtime'da bu obje zaten bir Message,
      // sadece ChatMessage olarak typed. Cast güvenli.
      storeSetReplyingTo(msg as Message | null);
    },
    [storeSetReplyingTo]
  );

  const setScrollToMessageId = useCallback(
    (id: string | null) => storeSetScrollToMessageId(id),
    [storeSetScrollToMessageId]
  );

  const sendTyping = useCallback(
    () => sendTypingProp(channelId),
    [channelId, sendTypingProp]
  );

  const pinMessage = useCallback(
    async (messageId: string) => {
      await pinAction(channelId, messageId);
    },
    [channelId, pinAction]
  );

  const unpinMessage = useCallback(
    async (messageId: string) => {
      await unpinAction(channelId, messageId);
    },
    [channelId, unpinAction]
  );

  const isMessagePinned = useCallback(
    (messageId: string) => storeIsMessagePinned(channelId, messageId),
    [channelId, storeIsMessagePinned]
  );

  // ─── Context Value (memoized) ───
  const value: ChatContextValue = useMemo(
    () => ({
      mode: "channel" as const,
      channelId,
      channelName,
      messages,
      isLoading,
      isLoadingMore,
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
      canSend,
      canManageMessages,
      showRoleColors: true,
      members,
      addFilesRef,
    }),
    [
      channelId, channelName, messages, isLoading, isLoadingMore, hasMore,
      replyingTo, scrollToMessageId, typingUsers,
      sendMessage, editMessage, deleteMessage, fetchMessages, fetchOlderMessages,
      toggleReaction, setReplyingTo, setScrollToMessageId, sendTyping,
      pinMessage, unpinMessage, isMessagePinned,
      canSend, canManageMessages, members, addFilesRef,
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export default ChannelChatProvider;
