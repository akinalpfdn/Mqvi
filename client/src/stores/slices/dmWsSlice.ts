import type { StateCreator } from "zustand";
import type { DMChannelWithUser, DMDeliveryMark, DMMessage, ReactionGroup } from "../../types";
import { useUIStore } from "../uiStore";
import {
  createTypingHandler,
  updateMessageInRecord,
  deleteMessageFromRecord,
  updateReactionInRecord,
  updateAuthorInRecord,
} from "../shared/messageUtils";
import { sortChannelsByActivity } from "../shared/dmSort";
import { useAuthStore } from "../authStore";
import { useOutboxStore } from "../outboxStore";
import type { DMStore } from "../dmStore";

export type DMWsSlice = {
  /**
   * The latest dm_delivered per conversation. Kept, not just applied: the other app can report
   * before this device's own send is confirmed, and that message is marked when it lands.
   */
  deliveredMarks: Record<string, DMDeliveryMark>;
  /** The other participant's app received the conversation this far: double tick on own messages. */
  handleDMDelivered: (mark: DMDeliveryMark) => void;
  handleDMChannelCreate: (channel: DMChannelWithUser) => void;
  handleDMMessageCreate: (message: DMMessage) => void;
  handleDMMessageUpdate: (message: DMMessage) => void;
  handleDMMessageDelete: (data: { id: string; dm_channel_id: string }) => void;
  handleDMReactionUpdate: (data: { dm_message_id: string; dm_channel_id: string; reactions: ReactionGroup[] }) => void;
  handleDMTypingStart: (channelId: string, username: string) => void;
  handleDMMessagePin: (data: { dm_channel_id: string; message: DMMessage }) => void;
  handleDMMessageUnpin: (data: { dm_channel_id: string; message_id: string }) => void;
  handleDMSettingsUpdate: (data: { dm_channel_id: string; action: string }) => void;
  handleDMChannelUpdate: (channel: DMChannelWithUser) => void;
  handleDMChannelStatusChange: (data: { dm_channel_id: string; status: "accepted" | "pending"; initiated_by: string | null }) => void;
  handleDMRequestAccept: (data: { dm_channel_id: string }) => void;
  handleDMRequestDecline: (data: { dm_channel_id: string }) => void;
  handleDMAuthorUpdate: (userId: string, patch: { display_name?: string | null; avatar_url?: string | null }) => void;
};

export const createDMWsSlice: StateCreator<
  DMStore,
  [],
  [],
  DMWsSlice
> = (set, get) => ({
  deliveredMarks: {},

  handleDMDelivered: (mark) => {
    set((state) => {
      const marks = { ...state.deliveredMarks, [mark.dm_channel_id]: mark };
      const held = state.messagesByChannel[mark.dm_channel_id];
      if (!held) return { deliveredMarks: marks };
      const me = useAuthStore.getState().user?.id;
      const markIndex = held.findIndex((m) => m.id === mark.message_id);
      const markTime = Date.parse(mark.created_at);
      let changed = false;
      const next = held.map((m, i) => {
        if (m.user_id !== me || m.delivered) return m;
        // Held: everything up to it. Not held: strictly older only — a same-second message may
        // come after the mark, and the next page says for certain.
        const reached = markIndex !== -1 ? i <= markIndex : Date.parse(m.created_at) < markTime;
        if (!reached) return m;
        changed = true;
        return { ...m, delivered: true };
      });
      return changed
        ? { deliveredMarks: marks, messagesByChannel: { ...state.messagesByChannel, [mark.dm_channel_id]: next } }
        : { deliveredMarks: marks };
    });
  },

  handleDMChannelCreate: (channel) => {
    set((state) => {
      if (state.channels.some((ch) => ch.id === channel.id)) return state;
      return { channels: [channel, ...state.channels] };
    });
  },

  handleDMMessageCreate: (incoming) => {
    set((state) => {
      // This device's own send, confirmed after the other app already reported it.
      const mark = state.deliveredMarks[incoming.dm_channel_id];
      const message =
        mark?.message_id === incoming.id && incoming.user_id === useAuthStore.getState().user?.id
          ? { ...incoming, delivered: true }
          : incoming;
      const updatedChannels = state.channels.map((ch) =>
        ch.id === message.dm_channel_id
          ? { ...ch, last_message_at: message.created_at }
          : ch
      );
      const sortedChannels = sortChannelsByActivity(updatedChannels);

      const typingUsers = { ...state.typingUsers };
      if (typingUsers[message.dm_channel_id]) {
        typingUsers[message.dm_channel_id] = typingUsers[message.dm_channel_id].filter(
          (u) => u !== message.author?.username
        );
      }

      const channelMessages = state.messagesByChannel[message.dm_channel_id];
      if (!channelMessages) {
        return { channels: sortedChannels, typingUsers };
      }

      // The send response and the echo both land here, whichever comes first; a held copy that
      // could not be decrypted takes the content the later one brings.
      const heldIndex = channelMessages.findIndex((m) => m.id === message.id);
      if (heldIndex !== -1) {
        if (channelMessages[heldIndex].content !== null || message.content === null) {
          return { channels: sortedChannels, typingUsers };
        }
        const next = [...channelMessages];
        next[heldIndex] = message;
        return {
          channels: sortedChannels,
          messagesByChannel: { ...state.messagesByChannel, [message.dm_channel_id]: next },
          typingUsers,
        };
      }

      return {
        channels: sortedChannels,
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.dm_channel_id]: [...channelMessages, message],
        },
        typingUsers,
      };
    });

    // Only the author's nonce: nobody else can confirm this device's outbox.
    if (incoming.client_nonce && incoming.user_id === useAuthStore.getState().user?.id) {
      useOutboxStore.getState().remove(incoming.client_nonce);
    }
  },

  handleDMMessageUpdate: (message) => {
    set((state) => ({
      messagesByChannel: updateMessageInRecord(
        state.messagesByChannel, message.dm_channel_id, message
      ),
    }));
  },

  handleDMMessageDelete: (data) => {
    set((state) => ({
      messagesByChannel: deleteMessageFromRecord(
        state.messagesByChannel, data.dm_channel_id, data.id
      ),
    }));
  },

  handleDMReactionUpdate: (data) => {
    set((state) => ({
      messagesByChannel: updateReactionInRecord(
        state.messagesByChannel, data.dm_channel_id, data.dm_message_id, data.reactions
      ),
    }));
  },

  handleDMTypingStart: createTypingHandler(set),

  handleDMMessagePin: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.message.id ? { ...m, is_pinned: true } : m
          ),
        },
      };
    });
  },

  handleDMMessageUnpin: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.message_id ? { ...m, is_pinned: false } : m
          ),
        },
      };
    });
  },

  handleDMSettingsUpdate: (data) => {
    const { dm_channel_id, action } = data;

    switch (action) {
      case "hidden":
        set((state) => ({
          channels: state.channels.filter((ch) => ch.id !== dm_channel_id),
          selectedDMId: state.selectedDMId === dm_channel_id ? null : state.selectedDMId,
        }));
        break;

      case "unhidden":
        get().fetchChannels();
        break;

      case "pinned":
        set((state) => ({
          channels: sortChannelsByActivity(
            state.channels.map((ch) =>
              ch.id === dm_channel_id ? { ...ch, is_pinned: true } : ch
            )
          ),
        }));
        break;

      case "unpinned":
        set((state) => ({
          channels: sortChannelsByActivity(
            state.channels.map((ch) =>
              ch.id === dm_channel_id ? { ...ch, is_pinned: false } : ch
            )
          ),
        }));
        break;

      case "muted":
        set((state) => ({
          channels: state.channels.map((ch) =>
            ch.id === dm_channel_id ? { ...ch, is_muted: true } : ch
          ),
        }));
        break;

      case "unmuted":
        set((state) => ({
          channels: state.channels.map((ch) =>
            ch.id === dm_channel_id ? { ...ch, is_muted: false } : ch
          ),
        }));
        break;
    }
  },

  handleDMChannelUpdate: (channel) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === channel.id ? { ...ch, ...channel } : ch
      ),
    }));
  },

  handleDMChannelStatusChange: (data) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === data.dm_channel_id ? { ...ch, status: data.status, initiated_by: data.initiated_by } : ch
      ),
    }));
  },

  handleDMRequestAccept: (data) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === data.dm_channel_id ? { ...ch, status: "accepted" as const, initiated_by: null } : ch
      ),
    }));
  },

  handleDMRequestDecline: (data) => {
    useUIStore.getState().closeDMTab(data.dm_channel_id);
    set((state) => ({
      channels: state.channels.filter((ch) => ch.id !== data.dm_channel_id),
      selectedDMId: state.selectedDMId === data.dm_channel_id ? null : state.selectedDMId,
    }));
  },

  handleDMAuthorUpdate: (userId, patch) => {
    set((state) => {
      const { updated, changed: messagesChanged } = updateAuthorInRecord(
        state.messagesByChannel, userId, patch
      );

      let channelsChanged = false;
      const updatedChannels = state.channels.map((ch) => {
        if (ch.other_user?.id !== userId) return ch;
        channelsChanged = true;
        return { ...ch, other_user: { ...ch.other_user, ...patch } };
      });

      return (messagesChanged || channelsChanged)
        ? { messagesByChannel: updated, channels: updatedChannels }
        : state;
    });
  },
});
