/**
 * DM-domain WS event handlers.
 * Handles: DM channel, DM message CRUD, DM typing, DM reactions, DM pins, DM settings.
 */

import { useDMStore } from "../../stores/dmStore";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { decryptDMMessage, popSentPlaintext, popEditPlaintext } from "../../crypto/dmEncryption";
import * as keyStorage from "../../crypto/keyStorage";
import { playNotificationSound } from "../../utils/sounds";
import type { WSMessage, DMChannelWithUser, DMMessage, ReactionGroup } from "../../types";

export async function handleDMEvent(msg: WSMessage): Promise<boolean> {
  switch (msg.op) {
    case "dm_channel_create":
      useDMStore.getState().handleDMChannelCreate(msg.d as DMChannelWithUser);
      return true;
    case "dm_channel_update": {
      const dmChannel = msg.d as DMChannelWithUser;
      useDMStore.getState().handleDMChannelUpdate(dmChannel);
      // Trigger recovery password prompt if E2EE was just enabled
      if (dmChannel.e2ee_enabled) {
        useE2EEStore.getState().checkAndPromptRecovery();
      }
      return true;
    }

    case "dm_message_create": {
      let dmMsg = msg.d as DMMessage;
      const dmCurrentUserId = useAuthStore.getState().user?.id;

      if (dmMsg.encryption_version === 1 && dmMsg.ciphertext && dmMsg.sender_device_id) {
        const isOwnMessage = dmMsg.user_id === dmCurrentUserId;
        let decrypted = false;

        if (isOwnMessage) {
          try {
            const cached = popSentPlaintext(dmMsg.dm_channel_id);
            if (cached) {
              dmMsg = { ...dmMsg, content: cached.content, e2ee_file_keys: cached.file_keys };
              decrypted = true;
              keyStorage.cacheDecryptedMessage({
                messageId: dmMsg.id, channelId: "", dmChannelId: dmMsg.dm_channel_id,
                content: cached.content, timestamp: new Date(dmMsg.created_at).getTime(),
              }).catch(() => {});
            } else {
              const idbCached = await keyStorage.getCachedDecryptedMessage(dmMsg.id);
              if (idbCached) {
                dmMsg = { ...dmMsg, content: idbCached.content };
                decrypted = true;
              }
            }
          } catch (cacheErr) {
            console.error("[ws] DM own message cache lookup failed:", cacheErr);
          }
        }

        if (!decrypted) {
          try {
            const payload = await decryptDMMessage(dmMsg.user_id, dmMsg.ciphertext!, dmMsg.sender_device_id!);
            if (payload) {
              dmMsg = { ...dmMsg, content: payload.content, e2ee_file_keys: payload.file_keys };
              if (payload.content) {
                keyStorage.cacheDecryptedMessage({
                  messageId: dmMsg.id, channelId: "", dmChannelId: dmMsg.dm_channel_id,
                  content: payload.content, timestamp: new Date(dmMsg.created_at).getTime(),
                }).catch(() => {});
              }
            } else {
              dmMsg = { ...dmMsg, content: null };
            }
          } catch (err) {
            console.error("[ws] DM decrypt failed:", err);
            dmMsg = { ...dmMsg, content: null };
            useE2EEStore.getState().addDecryptionError({
              messageId: dmMsg.id, channelId: dmMsg.dm_channel_id,
              error: err instanceof Error ? err.message : "Decryption failed", timestamp: Date.now(),
            });
          }
        }
      }

      useDMStore.getState().handleDMMessageCreate(dmMsg);

      if (dmMsg.user_id === dmCurrentUserId) return true;

      const dmState = useDMStore.getState();
      if (dmMsg.dm_channel_id !== dmState.selectedDMId) {
        dmState.incrementDMUnread(dmMsg.dm_channel_id);
        playNotificationSound();
        window.electronAPI?.flashFrame();
      }
      return true;
    }

    case "dm_message_update": {
      let dmUpdateMsg = msg.d as DMMessage;
      const dmEditCurrentUserId = useAuthStore.getState().user?.id;

      if (dmUpdateMsg.encryption_version === 1 && dmUpdateMsg.ciphertext && dmUpdateMsg.sender_device_id) {
        const isOwnEdit = dmUpdateMsg.user_id === dmEditCurrentUserId;
        let editDecrypted = false;

        if (isOwnEdit) {
          try {
            const cached = popEditPlaintext(dmUpdateMsg.id);
            if (cached) {
              dmUpdateMsg = { ...dmUpdateMsg, content: cached.content, e2ee_file_keys: cached.file_keys };
              editDecrypted = true;
            } else {
              const idbCached = await keyStorage.getCachedDecryptedMessage(dmUpdateMsg.id);
              if (idbCached) {
                dmUpdateMsg = { ...dmUpdateMsg, content: idbCached.content };
                editDecrypted = true;
              }
            }
          } catch (cacheErr) {
            console.error("[ws] DM own edit cache lookup failed:", cacheErr);
          }
        }

        if (!editDecrypted) {
          try {
            const payload = await decryptDMMessage(
              dmUpdateMsg.user_id, dmUpdateMsg.ciphertext!, dmUpdateMsg.sender_device_id!
            );
            dmUpdateMsg = { ...dmUpdateMsg, content: payload?.content ?? null, e2ee_file_keys: payload?.file_keys };

            if (payload?.content) {
              keyStorage.cacheDecryptedMessage({
                messageId: dmUpdateMsg.id, channelId: "", dmChannelId: dmUpdateMsg.dm_channel_id,
                content: payload.content, timestamp: new Date(dmUpdateMsg.created_at).getTime(),
              }).catch(() => {});
            }
          } catch (err) {
            console.error("[ws] DM edit decrypt failed:", err);
            dmUpdateMsg = { ...dmUpdateMsg, content: null };
          }
        }
      }

      useDMStore.getState().handleDMMessageUpdate(dmUpdateMsg);
      return true;
    }

    case "dm_message_delete": {
      const dmDelData = msg.d as { id: string; dm_channel_id: string };
      const dmState = useDMStore.getState();
      const dmUnread = dmState.dmUnreadCounts[dmDelData.dm_channel_id] ?? 0;
      if (dmUnread > 0) {
        const dmMessages = dmState.messagesByChannel[dmDelData.dm_channel_id];
        const deletedDMMsg = dmMessages?.find((m) => m.id === dmDelData.id);
        const myId = useAuthStore.getState().user?.id;
        if (deletedDMMsg?.user_id !== myId) {
          dmState.decrementDMUnread(dmDelData.dm_channel_id);
        }
      }
      dmState.handleDMMessageDelete(dmDelData);
      return true;
    }

    case "dm_reaction_update": {
      const data = msg.d as { dm_message_id: string; dm_channel_id: string; reactions: ReactionGroup[] };
      useDMStore.getState().handleDMReactionUpdate(data);
      return true;
    }

    case "dm_typing_start": {
      const data = msg.d as { user_id: string; username: string; dm_channel_id: string };
      useDMStore.getState().handleDMTypingStart(data.dm_channel_id, data.username);
      return true;
    }

    case "dm_message_pin":
      useDMStore.getState().handleDMMessagePin(msg.d as { dm_channel_id: string; message: DMMessage });
      return true;
    case "dm_message_unpin":
      useDMStore.getState().handleDMMessageUnpin(msg.d as { dm_channel_id: string; message_id: string });
      return true;

    case "dm_settings_update":
      useDMStore.getState().handleDMSettingsUpdate(msg.d as { dm_channel_id: string; action: string });
      return true;

    case "dm_request_accept":
      useDMStore.getState().handleDMRequestAccept(msg.d as { dm_channel_id: string });
      return true;
    case "dm_request_decline":
      useDMStore.getState().handleDMRequestDecline(msg.d as { dm_channel_id: string });
      return true;

    default:
      return false;
  }
}
