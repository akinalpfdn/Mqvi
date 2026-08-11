/**
 * voiceMessageStore — ephemeral voice channel chat messages, scoped per channel.
 *
 * Lifecycle:
 *  - load via listVoiceMessages on chat panel open
 *  - the sender applies its own send/edit/delete here; other clients get it from the WS handlers
 *  - wipeChannel called when voice_channel_timer_stop arrives (last person left)
 */

import { create } from "zustand";
import * as voiceMessageApi from "../api/voiceMessages";
import type { UploadOptions } from "../api/client";
import type { VoiceMessage } from "../types";

type VoiceMessageState = {
  /** channelId -> messages (chronological asc) */
  messagesByChannel: Record<string, VoiceMessage[]>;

  /** Replace the entire list for a channel (used after listVoiceMessages). */
  setForChannel: (channelId: string, messages: VoiceMessage[]) => void;
  /** Append a single message from WS create event (dedup by id). */
  append: (message: VoiceMessage) => void;
  /** Replace an existing message in place after edit. */
  update: (message: VoiceMessage) => void;
  /** Remove a deleted message. */
  remove: (channelId: string, messageId: string) => void;
  /** Wipe all messages for a channel (fired when channel goes empty). */
  wipeChannel: (channelId: string) => void;

  // ─── Mutations ───
  // The sender's own message lands here instead of waiting for voice_message_create to come back.
  // Each applies its result through the handler the echo uses, so the two paths cannot drift, and
  // all three of those dedup by id — the echo replaying this is a no-op.
  send: (
    channelId: string,
    content: string,
    files?: File[],
    upload?: UploadOptions
  ) => Promise<boolean>;
  edit: (channelId: string, messageId: string, content: string) => Promise<boolean>;
  del: (channelId: string, messageId: string) => Promise<boolean>;
};

export const useVoiceMessageStore = create<VoiceMessageState>((set, get) => ({
  messagesByChannel: {},

  setForChannel: (channelId, messages) => {
    set((state) => ({
      messagesByChannel: { ...state.messagesByChannel, [channelId]: messages },
    }));
  },

  append: (message) => {
    set((state) => {
      const existing = state.messagesByChannel[message.channel_id] ?? [];
      if (existing.some((m) => m.id === message.id)) return state;
      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channel_id]: [...existing, message],
        },
      };
    });
  },

  update: (message) => {
    set((state) => {
      const list = state.messagesByChannel[message.channel_id];
      if (!list) return state;
      let changed = false;
      const next = list.map((m) => {
        if (m.id === message.id) {
          changed = true;
          return message;
        }
        return m;
      });
      if (!changed) return state;
      return {
        messagesByChannel: { ...state.messagesByChannel, [message.channel_id]: next },
      };
    });
  },

  remove: (channelId, messageId) => {
    set((state) => {
      const list = state.messagesByChannel[channelId];
      if (!list) return state;
      const next = list.filter((m) => m.id !== messageId);
      if (next.length === list.length) return state;
      return {
        messagesByChannel: { ...state.messagesByChannel, [channelId]: next },
      };
    });
  },

  wipeChannel: (channelId) => {
    set((state) => {
      if (!(channelId in state.messagesByChannel)) return state;
      const next = { ...state.messagesByChannel };
      delete next[channelId];
      return { messagesByChannel: next };
    });
  },

  // ─── Mutations ───

  send: async (channelId, content, files, upload) => {
    const res = await voiceMessageApi.sendVoiceMessage(channelId, content, files, upload);
    if (!res.success || !res.data) return false;

    get().append(res.data);
    return true;
  },

  edit: async (channelId, messageId, content) => {
    const res = await voiceMessageApi.editVoiceMessage(channelId, messageId, content);
    if (!res.success || !res.data) return false;

    get().update(res.data);
    return true;
  },

  del: async (channelId, messageId) => {
    const res = await voiceMessageApi.deleteVoiceMessage(channelId, messageId);
    if (!res.success) return false;

    get().remove(channelId, messageId);
    return true;
  },
}));
