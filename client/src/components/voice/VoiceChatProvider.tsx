/**
 * VoiceChatProvider — Maps voiceMessageStore + voiceMessages API to ChatContext,
 * so the existing Message/MessageInput/MessageList components can render the
 * ephemeral voice channel chat without duplicating UI.
 *
 * Voice chat has no reactions/replies/pins/mentions/typing — those context
 * actions are stubbed as no-ops and gated off in shared components via
 * `mode === "voice"`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatContext, type ChatContextValue, type ChatMessage } from "../../hooks/useChatContext";
import { useVoiceMessageStore } from "../../stores/voiceMessageStore";
import {
  listVoiceMessages,
  sendVoiceMessage,
  editVoiceMessage,
  deleteVoiceMessage,
} from "../../api/voiceMessages";
import type { MemberWithRoles, VoiceMessage } from "../../types";
import type { UploadOptions } from "../../api/client";

const EMPTY_VOICE: VoiceMessage[] = [];
const EMPTY_STRINGS: string[] = [];
const EMPTY_MEMBERS: MemberWithRoles[] = [];

type Props = {
  channelId: string;
  channelName: string;
  children: ReactNode;
};

function VoiceChatProvider({ channelId, channelName, children }: Props) {
  const rawMessages = useVoiceMessageStore(
    (s) => s.messagesByChannel[channelId] ?? EMPTY_VOICE,
  );
  const setForChannel = useVoiceMessageStore((s) => s.setForChannel);

  // Adapt VoiceMessage → ChatMessage shape with safe defaults for the fields
  // shared components might read (reply/pin/reactions) — voice chat has none.
  const messages = useMemo<ChatMessage[]>(
    () =>
      rawMessages.map((m) => ({
        id: m.id,
        user_id: m.user_id,
        content: m.content,
        edited_at: m.edited_at,
        created_at: m.created_at,
        reply_to_id: null,
        is_pinned: false,
        author: m.author,
        attachments: (m.attachments ?? []).map((a) => ({
          id: a.id,
          filename: a.filename,
          file_url: a.file_url,
          file_size: a.file_size,
          mime_type: a.mime_type,
        })),
        reactions: [],
        referenced_message: null,
      })),
    [rawMessages],
  );

  const [isLoading, setIsLoading] = useState(true);
  const addFilesRef = useRef<((files: File[]) => void) | null>(null);

  // Initial load when channel changes.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    listVoiceMessages(channelId).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setForChannel(channelId, res.data);
      }
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [channelId, setForChannel]);

  const sendMessage = useCallback(
    async (content: string, files?: File[], _replyToId?: string, upload?: UploadOptions) => {
      const res = await sendVoiceMessage(channelId, content, files, upload);
      return res.success;
    },
    [channelId],
  );

  const editMessage = useCallback(
    async (id: string, content: string) => {
      const res = await editVoiceMessage(channelId, id, content);
      return res.success;
    },
    [channelId],
  );

  const deleteMessageAction = useCallback(
    async (id: string) => {
      const res = await deleteVoiceMessage(channelId, id);
      return res.success;
    },
    [channelId],
  );

  const fetchMessages = useCallback(async () => {
    const res = await listVoiceMessages(channelId);
    if (res.success && res.data) {
      setForChannel(channelId, res.data);
    }
  }, [channelId, setForChannel]);

  const noopAsync = useCallback(async () => {}, []);

  const value: ChatContextValue = useMemo(
    () => ({
      mode: "voice" as const,
      channelId,
      channelName,
      serverId: undefined,
      messages,
      isLoading,
      isLoadingMore: false,
      hasMore: false,
      replyingTo: null,
      scrollToMessageId: null,
      typingUsers: EMPTY_STRINGS,
      sendMessage,
      editMessage,
      deleteMessage: deleteMessageAction,
      fetchMessages,
      fetchOlderMessages: noopAsync,
      toggleReaction: () => {},
      setReplyingTo: () => {},
      setScrollToMessageId: () => {},
      sendTyping: () => {},
      pinMessage: noopAsync,
      unpinMessage: noopAsync,
      isMessagePinned: () => false,
      canSend: true,
      canManageMessages: false,
      showRoleColors: false,
      members: EMPTY_MEMBERS,
      addFilesRef,
    }),
    [
      channelId, channelName, messages, isLoading,
      sendMessage, editMessage, deleteMessageAction, fetchMessages, noopAsync,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export default VoiceChatProvider;
