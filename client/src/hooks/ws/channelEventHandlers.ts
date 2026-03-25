/**
 * Channel-domain WS event handlers.
 * Handles: channel CRUD, category CRUD, message CRUD, typing, reactions, pins, permissions.
 */

import { useChannelStore } from "../../stores/channelStore";
import { useMessageStore } from "../../stores/messageStore";
import { useServerStore } from "../../stores/serverStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useAuthStore } from "../../stores/authStore";
import { useUIStore } from "../../stores/uiStore";
import { usePinStore } from "../../stores/pinStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { decryptChannelMessage } from "../../crypto/channelEncryption";
import * as keyStorage from "../../crypto/keyStorage";
import { playNotificationSound } from "../../utils/sounds";
import type {
  WSMessage,
  Channel,
  Category,
  Message,
  ReactionGroup,
  PinnedMessage,
  ChannelPermissionOverride,
} from "../../types";

export async function handleChannelEvent(msg: WSMessage): Promise<boolean> {
  switch (msg.op) {
    case "channel_create":
      useChannelStore.getState().fetchChannels();
      return true;
    case "channel_update": {
      const ch = msg.d as Channel;
      useChannelStore.getState().handleChannelUpdate(ch);
      useUIStore.getState().updateTabLabel(ch.id, ch.name);
      return true;
    }
    case "channel_delete":
      useChannelStore.getState().handleChannelDelete((msg.d as { id: string }).id);
      return true;
    case "channel_reorder":
      useChannelStore.getState().fetchChannels();
      return true;

    case "category_create":
      useChannelStore.getState().handleCategoryCreate(msg.d as Category);
      return true;
    case "category_update":
      useChannelStore.getState().handleCategoryUpdate(msg.d as Category);
      return true;
    case "category_delete":
      useChannelStore.getState().handleCategoryDelete((msg.d as { id: string }).id);
      return true;
    case "category_reorder":
      useChannelStore.getState().handleCategoryReorder();
      return true;

    case "message_create": {
      let message = msg.d as Message;

      const e2eeReady = useE2EEStore.getState().initStatus === "ready";
      if (e2eeReady && message.encryption_version === 1 && message.ciphertext && message.sender_device_id) {
        try {
          const payload = await decryptChannelMessage(
            message.user_id, message.channel_id, message.ciphertext, message.sender_device_id
          );
          message = { ...message, content: payload?.content ?? null, e2ee_file_keys: payload?.file_keys };

          if (payload?.content) {
            keyStorage.cacheDecryptedMessage({
              messageId: message.id, channelId: message.channel_id, dmChannelId: null,
              content: payload.content, timestamp: new Date(message.created_at).getTime(),
            }).catch(() => {});
          }
        } catch (err) {
          console.error("[useWebSocket] Channel message decryption failed:", err);
          message = { ...message, content: null };
          useE2EEStore.getState().addDecryptionError({
            messageId: message.id, channelId: message.channel_id,
            error: err instanceof Error ? err.message : "Decryption failed", timestamp: Date.now(),
          });
        }
      }

      const msgServerId = message.server_id;
      if (msgServerId) {
        useReadStateStore.getState().registerChannel(message.channel_id, msgServerId);
      }

      const activeServerId = useServerStore.getState().activeServerId;
      const isActiveServer = msgServerId === activeServerId;

      if (isActiveServer) {
        useMessageStore.getState().handleMessageCreate(message);
      }

      const currentUserId = useAuthStore.getState().user?.id;
      if (message.author?.id === currentUserId || message.user_id === currentUserId) {
        return true;
      }

      const uiState = useUIStore.getState();
      const panel = uiState.panels[uiState.activePanelId];
      const activeTab = panel?.tabs.find((t) => t.id === panel.activeTabId);
      const isViewingThisChannel =
        isActiveServer && activeTab?.type === "text" && activeTab?.channelId === message.channel_id;

      if (isViewingThisChannel) {
        useReadStateStore.getState().markAsRead(message.channel_id, message.id);
      } else {
        const isServerMuted = msgServerId ? useServerStore.getState().isServerMuted(msgServerId) : false;
        const isChannelMuted = useChannelStore.getState().mutedChannelIds.has(message.channel_id);
        if (!isServerMuted && !isChannelMuted) {
          useReadStateStore.getState().incrementUnread(message.channel_id);
          playNotificationSound();
          window.electronAPI?.flashFrame();
        }
      }
      return true;
    }

    case "message_update": {
      let updatedMsg = msg.d as Message;

      const e2eeReadyForUpdate = useE2EEStore.getState().initStatus === "ready";
      if (e2eeReadyForUpdate && updatedMsg.encryption_version === 1 && updatedMsg.ciphertext && updatedMsg.sender_device_id) {
        try {
          const payload = await decryptChannelMessage(
            updatedMsg.user_id, updatedMsg.channel_id, updatedMsg.ciphertext, updatedMsg.sender_device_id
          );
          updatedMsg = { ...updatedMsg, content: payload?.content ?? null, e2ee_file_keys: payload?.file_keys };

          if (payload?.content) {
            keyStorage.cacheDecryptedMessage({
              messageId: updatedMsg.id, channelId: updatedMsg.channel_id, dmChannelId: null,
              content: payload.content, timestamp: new Date(updatedMsg.created_at).getTime(),
            }).catch(() => {});
          }
        } catch (err) {
          console.error("[useWebSocket] Channel message update decryption failed:", err);
          updatedMsg = { ...updatedMsg, content: null };
        }
      }

      useMessageStore.getState().handleMessageUpdate(updatedMsg);
      return true;
    }

    case "message_delete": {
      const delData = msg.d as { id: string; channel_id: string };

      const unreadCount = useReadStateStore.getState().unreadCounts[delData.channel_id] ?? 0;
      if (unreadCount > 0) {
        const channelMessages = useMessageStore.getState().messagesByChannel[delData.channel_id];
        const deletedMsg = channelMessages?.find((m) => m.id === delData.id);
        const myId = useAuthStore.getState().user?.id;
        const isOwnMessage = deletedMsg?.user_id === myId || deletedMsg?.author?.id === myId;
        if (!isOwnMessage) {
          useReadStateStore.getState().decrementUnread(delData.channel_id);
        }
      }

      useMessageStore.getState().handleMessageDelete(delData);
      return true;
    }

    case "typing_start": {
      const data = msg.d as { channel_id: string; username: string };
      useMessageStore.getState().handleTypingStart(data.channel_id, data.username);
      return true;
    }

    case "message_pin":
      usePinStore.getState().handleMessagePin(msg.d as PinnedMessage);
      return true;
    case "message_unpin":
      usePinStore.getState().handleMessageUnpin(msg.d as { message_id: string; channel_id: string });
      return true;

    case "reaction_update": {
      const reactionData = msg.d as {
        message_id: string; channel_id: string; reactions: ReactionGroup[];
        actor_id: string; message_author_id: string; added: boolean;
      };
      useMessageStore.getState().handleReactionUpdate(reactionData);

      if (reactionData.added) {
        const myId = useAuthStore.getState().user?.id;
        if (reactionData.message_author_id === myId && reactionData.actor_id !== myId) {
          const uiState = useUIStore.getState();
          const panel = uiState.panels[uiState.activePanelId];
          const activeTab = panel?.tabs.find((tab) => tab.id === panel.activeTabId);
          const isViewingChannel = activeTab?.type === "text" && activeTab?.channelId === reactionData.channel_id;
          if (!isViewingChannel) {
            useReadStateStore.getState().incrementUnread(reactionData.channel_id);
            playNotificationSound();
          }
        }
      }
      return true;
    }

    case "channel_permission_update": {
      useChannelPermissionStore.getState().handleOverrideUpdate(msg.d as ChannelPermissionOverride);
      const cpUpd = msg.d as ChannelPermissionOverride;
      useChannelStore.getState().fetchChannels().then(() => {
        const allVisible = useChannelStore.getState().categories.flatMap((c) => c.channels);
        if (!allVisible.some((ch) => ch.id === cpUpd.channel_id)) {
          useUIStore.getState().closeTextTabByChannel(cpUpd.channel_id);
        }
      });
      return true;
    }
    case "channel_permission_delete": {
      const cpDel = msg.d as { channel_id: string; role_id: string };
      useChannelPermissionStore.getState().handleOverrideDelete(cpDel.channel_id, cpDel.role_id);
      useChannelStore.getState().fetchChannels().then(() => {
        const allVisible = useChannelStore.getState().categories.flatMap((c) => c.channels);
        if (!allVisible.some((ch) => ch.id === cpDel.channel_id)) {
          useUIStore.getState().closeTextTabByChannel(cpDel.channel_id);
        }
      });
      return true;
    }

    default:
      return false;
  }
}
