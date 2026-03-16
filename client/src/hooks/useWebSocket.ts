/**
 * useWebSocket — WebSocket connection and event routing hook.
 *
 * Singleton — only used in AppLayout.tsx.
 * Responsibilities:
 * 1. Establish WS connection on login
 * 2. Send heartbeats (30s interval, 3 misses = disconnect)
 * 3. Route incoming events to store handlers (switch/case)
 * 4. Auto-reconnect on disconnect (10s delay, max 5 attempts)
 * 5. Expose sendTyping for MessageInput
 *
 * StrictMode protection:
 * Each effect invocation gets a monotonically increasing connectionId.
 * Socket callbacks only execute if their connectionId is still active.
 * IDs are incremented (never reset) to prevent stale onclose collisions.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { ensureFreshToken } from "../api/client";
import { useChannelStore } from "../stores/channelStore";
import { useMessageStore } from "../stores/messageStore";
import { useMemberStore } from "../stores/memberStore";
import { useRoleStore } from "../stores/roleStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useServerStore } from "../stores/serverStore";
import { usePinStore } from "../stores/pinStore";
import { useReadStateStore } from "../stores/readStateStore";
import { useAuthStore } from "../stores/authStore";
import { useUIStore } from "../stores/uiStore";
import { useDMStore } from "../stores/dmStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import { useFriendStore } from "../stores/friendStore";
import { useBlockStore } from "../stores/blockStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
import {
  WS_URL,
  WS_HEARTBEAT_INTERVAL,
  WS_HEARTBEAT_MAX_MISS,
} from "../utils/constants";
import { playJoinSound, playLeaveSound, playNotificationSound } from "../utils/sounds";
import { useE2EEStore } from "../stores/e2eeStore";
import { useBadgeStore } from "../stores/badgeStore";
import {
  decryptDMMessage,
  popSentPlaintext,
  popEditPlaintext,
} from "../crypto/dmEncryption";
import { decryptChannelMessage } from "../crypto/channelEncryption";
import * as keyStorage from "../crypto/keyStorage";
import type {
  WSMessage,
  Channel,
  Category,
  Message,
  MemberWithRoles,
  Role,
  Server,
  ServerListItem,
  UserStatus,
  VoiceState,
  VoiceStateUpdateData,
  PinnedMessage,
  DMChannelWithUser,
  DMMessage,
  ReactionGroup,
  ChannelPermissionOverride,
  FriendshipWithUser,
  P2PCall,
  P2PSignalPayload,
} from "../types";

/** Fixed reconnect delay (ms) */
const RECONNECT_DELAY = 10_000;

/** Max reconnect attempts before showing "disconnected" */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Typing throttle (ms) — prevents flooding same channel */
const TYPING_THROTTLE = 3_000;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef<number>(0);
  const missedHeartbeatsRef = useRef<number>(0);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttemptRef = useRef<number>(0);

  /**
   * Monotonically increasing connection ID — StrictMode guard.
   * Never reset to 0; always incremented to keep IDs unique.
   */
  const activeConnectionIdRef = useRef<number>(0);

  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "connecting" | "disconnected"
  >("connecting");

  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

  /** Last typing timestamp per channel — throttle map */
  const lastTypingRef = useRef<Map<string, number>>(new Map());

  /**
   * routeEventRef — "latest ref" pattern.
   * Updated every render so onmessage always calls the freshest handler,
   * avoiding stale closures after HMR or re-renders.
   */
  const routeEventRef = useRef<(msg: WSMessage) => void>(() => {});

  /**
   * routeEvent — Dispatches WS events to store handlers by op code.
   * Accesses stores via getState() (outside React render cycle).
   * Async for E2EE message decryption (fire-and-forget from caller).
   */
  async function routeEvent(msg: WSMessage) {
    switch (msg.op) {
      // ─── Heartbeat ───
      case "heartbeat_ack":
        missedHeartbeatsRef.current = 0;
        break;

      // ─── Channel Events ───
      // channel_create/channel_reorder carry no data (nil).
      // Each client fetches based on its own ViewChannel permissions.
      case "channel_create":
        useChannelStore.getState().fetchChannels();
        break;
      case "channel_update": {
        const updatedChannel = msg.d as Channel;
        useChannelStore.getState().handleChannelUpdate(updatedChannel);
        useUIStore.getState().updateTabLabel(updatedChannel.id, updatedChannel.name);
        break;
      }
      case "channel_delete":
        useChannelStore.getState().handleChannelDelete((msg.d as { id: string }).id);
        break;
      case "channel_reorder":
        useChannelStore.getState().fetchChannels();
        break;

      // ─── Category Events ───
      case "category_create":
        useChannelStore.getState().handleCategoryCreate(msg.d as Category);
        break;
      case "category_update":
        useChannelStore.getState().handleCategoryUpdate(msg.d as Category);
        break;
      case "category_delete":
        useChannelStore.getState().handleCategoryDelete((msg.d as { id: string }).id);
        break;
      case "category_reorder":
        useChannelStore.getState().handleCategoryReorder();
        break;

      // ─── Message Events ───
      case "message_create": {
        let message = msg.d as Message;

        // E2EE decryption
        const e2eeReady = useE2EEStore.getState().initStatus === "ready";
        if (e2eeReady && message.encryption_version === 1 && message.ciphertext && message.sender_device_id) {
          try {
            const payload = await decryptChannelMessage(
              message.user_id,
              message.channel_id,
              message.ciphertext,
              message.sender_device_id
            );
            message = {
              ...message,
              content: payload?.content ?? null,
              e2ee_file_keys: payload?.file_keys,
            };

            // Cache decrypted content in IndexedDB for client-side search
            if (payload?.content) {
              keyStorage.cacheDecryptedMessage({
                messageId: message.id,
                channelId: message.channel_id,
                dmChannelId: null,
                content: payload.content,
                timestamp: new Date(message.created_at).getTime(),
              }).catch(() => {});
            }
          } catch (err) {
            console.error("[useWebSocket] Channel message decryption failed:", err);
            message = { ...message, content: null };
            useE2EEStore.getState().addDecryptionError({
              messageId: message.id,
              channelId: message.channel_id,
              error: err instanceof Error ? err.message : "Decryption failed",
              timestamp: Date.now(),
            });
          }
        }

        // Track channelId → serverId mapping for cross-server unread aggregation
        const msgServerId = message.server_id;
        if (msgServerId) {
          useReadStateStore.getState().registerChannel(message.channel_id, msgServerId);
        }

        // Determine if this message belongs to the currently active server
        const activeServerId = useServerStore.getState().activeServerId;
        const isActiveServer = msgServerId === activeServerId;

        // Only add to messageStore if it belongs to active server's channels
        // (messageStore is server-scoped — non-active server messages are not rendered)
        if (isActiveServer) {
          useMessageStore.getState().handleMessageCreate(message);
        }

        // Don't increment unread for own messages (server broadcasts to sender too)
        const currentUserId = useAuthStore.getState().user?.id;
        if (message.author?.id === currentUserId || message.user_id === currentUserId) {
          break;
        }

        // Check if user is actively viewing this channel
        const uiState = useUIStore.getState();
        const panel = uiState.panels[uiState.activePanelId];
        const activeTab = panel?.tabs.find((t) => t.id === panel.activeTabId);
        const isViewingThisChannel =
          isActiveServer &&
          activeTab?.type === "text" &&
          activeTab?.channelId === message.channel_id;

        if (isViewingThisChannel) {
          useReadStateStore.getState().markAsRead(message.channel_id, message.id);
        } else {
          // Muted server/channel check — use the MESSAGE's server, not activeServerId
          const isServerMuted = msgServerId
            ? useServerStore.getState().isServerMuted(msgServerId)
            : false;
          const isChannelMuted = useChannelStore.getState().mutedChannelIds.has(message.channel_id);
          const isEffectivelyMuted = isServerMuted || isChannelMuted;

          if (!isEffectivelyMuted) {
            useReadStateStore.getState().incrementUnread(message.channel_id);
            playNotificationSound();
            window.electronAPI?.flashFrame();
          }
        }
        break;
      }
      case "message_update": {
        let updatedMsg = msg.d as Message;

        // E2EE decryption for updated messages
        const e2eeReadyForUpdate = useE2EEStore.getState().initStatus === "ready";
        if (e2eeReadyForUpdate && updatedMsg.encryption_version === 1 && updatedMsg.ciphertext && updatedMsg.sender_device_id) {
          try {
            const payload = await decryptChannelMessage(
              updatedMsg.user_id,
              updatedMsg.channel_id,
              updatedMsg.ciphertext,
              updatedMsg.sender_device_id
            );
            updatedMsg = {
              ...updatedMsg,
              content: payload?.content ?? null,
              e2ee_file_keys: payload?.file_keys,
            };

            if (payload?.content) {
              keyStorage.cacheDecryptedMessage({
                messageId: updatedMsg.id,
                channelId: updatedMsg.channel_id,
                dmChannelId: null,
                content: payload.content,
                timestamp: new Date(updatedMsg.created_at).getTime(),
              }).catch(() => {});
            }
          } catch (err) {
            console.error("[useWebSocket] Channel message update decryption failed:", err);
            updatedMsg = { ...updatedMsg, content: null };
          }
        }

        useMessageStore.getState().handleMessageUpdate(updatedMsg);
        break;
      }
      case "message_delete": {
        const delData = msg.d as { id: string; channel_id: string };

        // Decrement unread if the deleted message wasn't ours
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
        break;
      }

      // ─── Typing ───
      case "typing_start": {
        const data = msg.d as { channel_id: string; username: string };
        useMessageStore.getState().handleTypingStart(data.channel_id, data.username);
        break;
      }

      // ─── Presence & Member Events ───
      case "ready": {
        const data = msg.d as {
          online_user_ids: string[];
          servers: ServerListItem[];
          muted_server_ids: string[];
          muted_channel_ids: string[];
        };

        if (data.servers) {
          useServerStore.getState().setServersFromReady(data.servers);
        }

        if (data.muted_server_ids) {
          useServerStore.getState().setMutedServersFromReady(data.muted_server_ids);
        }

        if (data.muted_channel_ids) {
          useChannelStore.getState().setMutedChannelsFromReady(data.muted_channel_ids);
        }

        useMemberStore.getState().handleReady(data.online_user_ids);
        // Fetch unread counts for ALL servers so cross-server badges work
        useReadStateStore.getState().fetchAllUnreadCounts();
        useDMStore.getState().fetchChannels();
        useDMStore.getState().fetchDMSettings();
        useFriendStore.getState().fetchFriends();
        useFriendStore.getState().fetchRequests();
        useBlockStore.getState().fetchBlocked();

        setConnectionStatus("connected");

        // Status persistence safety net: send manualStatus correction on ready.
        // Server already uses pref_status from WS URL, but this covers edge cases.
        {
          const storedStatus = useAuthStore.getState().manualStatus;
          if (storedStatus !== "online") {
            const ws = wsRef.current;
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({ op: "presence_update", d: { status: storedStatus } })
              );
            }
          }
        }

        // Voice auto-rejoin: if user was in a voice channel before WS dropped,
        // re-fetch a fresh LiveKit token and re-join automatically.
        {
          const voiceState = useVoiceStore.getState();
          const previousChannel = voiceState.currentVoiceChannelId;
          if (previousChannel) {
            console.log("[useWebSocket] WS reconnected while in voice, re-joining channel:", previousChannel);
            // Clear stale LiveKit credentials so VoiceProvider disconnects old session
            voiceState.leaveVoiceChannel();
            // Re-join with fresh token (async, fire-and-forget — errors logged inside)
            voiceState.joinVoiceChannel(previousChannel).then((tokenResp) => {
              if (tokenResp) {
                sendVoiceJoin(previousChannel);
              } else {
                console.warn("[useWebSocket] Voice auto-rejoin failed — user needs to rejoin manually");
              }
            });
          }
        }
        break;
      }
      case "presence_update": {
        const data = msg.d as { user_id: string; status: UserStatus };
        useMemberStore.getState().handlePresenceUpdate(data.user_id, data.status);
        const myId = useAuthStore.getState().user?.id;
        if (data.user_id === myId) {
          useAuthStore.getState().updateUser({ status: data.status });
        }
        break;
      }
      case "member_join":
        useMemberStore.getState().handleMemberJoin(msg.d as MemberWithRoles);
        break;
      case "member_leave":
        useMemberStore.getState().handleMemberLeave(
          (msg.d as { user_id: string }).user_id
        );
        break;
      case "member_update": {
        const updatedMember = msg.d as MemberWithRoles;
        useMemberStore.getState().handleMemberUpdate(updatedMember);
        // Sync voice display info on avatar/name change
        useVoiceStore.getState().updateUserInfo(
          updatedMember.id,
          updatedMember.display_name ?? updatedMember.username,
          updatedMember.avatar_url ?? "",
        );
        // Sync author info in cached messages (display_name / avatar)
        const authorPatch = {
          display_name: updatedMember.display_name,
          avatar_url: updatedMember.avatar_url,
        };
        useMessageStore.getState().handleAuthorUpdate(updatedMember.id, authorPatch);
        useDMStore.getState().handleDMAuthorUpdate(updatedMember.id, authorPatch);
        // Refetch channels if own roles changed (channel visibility may differ)
        const myUserId = useAuthStore.getState().user?.id;
        if (updatedMember.id === myUserId) {
          useChannelStore.getState().fetchChannels();
        }
        break;
      }

      // ─── Role Events ───
      // Dispatched to both memberStore (member list) and roleStore (settings panel)
      case "role_create": {
        const role = msg.d as Role;
        useMemberStore.getState().handleRoleCreate(role);
        useRoleStore.getState().handleRoleCreate(role);
        break;
      }
      case "role_update": {
        const role = msg.d as Role;
        useMemberStore.getState().handleRoleUpdate(role);
        useRoleStore.getState().handleRoleUpdate(role);
        // Role permission change may affect channel visibility (ViewChannel)
        useChannelStore.getState().fetchChannels();
        break;
      }
      case "role_delete": {
        const roleId = (msg.d as { id: string }).id;
        useMemberStore.getState().handleRoleDelete(roleId);
        useRoleStore.getState().handleRoleDelete(roleId);
        useChannelStore.getState().fetchChannels();
        break;
      }
      case "roles_reorder": {
        const roles = msg.d as Role[];
        useRoleStore.getState().handleRolesReorder(roles);
        useMemberStore.getState().handleRolesReorder(roles);
        break;
      }

      // ─── Voice Events ───
      case "voice_state_update": {
        const voiceData = msg.d as VoiceStateUpdateData;
        const voiceState = useVoiceStore.getState();

        // Capture state BEFORE store update for accurate sound decisions
        const prevStates = voiceState.voiceStates[voiceData.channel_id] ?? [];
        const prevStreaming = prevStates.find((s) => s.user_id === voiceData.user_id)?.is_streaming ?? false;
        const myUserId = useAuthStore.getState().user?.id;
        voiceState.handleVoiceStateUpdate(voiceData);

        // Play join/leave sounds for same-channel users or self.
        // Same-channel rejoin (WS reconnect) is safe — server skips that broadcast entirely.
        const isMe = voiceData.user_id === myUserId;
        const myChannelId = voiceState.currentVoiceChannelId;
        const isSameChannel = myChannelId && myChannelId === voiceData.channel_id;

        if (isSameChannel || isMe) {
          if (voiceData.action === "join") {
            playJoinSound();
          } else if (voiceData.action === "leave") {
            playLeaveSound();
          }
        }

        // Screen share start/stop sound for same-channel users (not self)
        if (isSameChannel && !isMe && voiceData.action === "update") {
          if (!prevStreaming && voiceData.is_streaming) {
            playJoinSound();
          } else if (prevStreaming && !voiceData.is_streaming) {
            playLeaveSound();
          }
        }
        break;
      }
      case "screen_share_viewer_update": {
        const viewerData = msg.d as {
          streamer_user_id: string;
          channel_id: string;
          viewer_count: number;
          viewer_user_id: string;
          action: string;
        };
        useVoiceStore.getState().handleScreenShareViewerUpdate(viewerData);

        // Play sound for the streamer when someone joins/leaves their screen share
        const myId = useAuthStore.getState().user?.id;
        if (myId === viewerData.streamer_user_id) {
          if (viewerData.action === "join") {
            playJoinSound();
          } else if (viewerData.action === "leave") {
            playLeaveSound();
          }
        }
        break;
      }
      case "voice_states_sync": {
        const syncData = msg.d as { states: VoiceState[] };
        const vs = useVoiceStore.getState();
        vs.handleVoiceStatesSync(syncData.states);

        // Self-recovery: if we're in voice but missing from sync, re-announce
        const myId = useAuthStore.getState().user?.id;
        const myVoiceChannel = vs.currentVoiceChannelId;
        if (myId && myVoiceChannel) {
          const isSelfInSync = syncData.states.some(
            (s) => s.user_id === myId && s.channel_id === myVoiceChannel,
          );
          if (!isSelfInSync) {
            sendVoiceJoin(myVoiceChannel);
          }
        }
        break;
      }

      // ─── Voice Moderation Events ───
      case "voice_force_move": {
        const forceMoveData = msg.d as { channel_id: string; channel_name?: string };
        const voiceStore = useVoiceStore.getState();

        voiceStore.leaveVoiceChannel();
        voiceStore.joinVoiceChannel(forceMoveData.channel_id).then((tokenResp) => {
          if (tokenResp) {
            sendVoiceJoin(forceMoveData.channel_id);

            const channelName = forceMoveData.channel_name
              ?? useChannelStore.getState().categories
                  .flatMap((cg) => cg.channels)
                  .find((ch) => ch.id === forceMoveData.channel_id)?.name
              ?? "";
            const srvState = useServerStore.getState();
            const activeSrv = srvState.activeServer
              ?? srvState.servers.find((s) => s.id === srvState.activeServerId);
            const serverInfo = activeSrv
              ? { serverId: activeSrv.id, serverName: activeSrv.name, serverIconUrl: activeSrv.icon_url }
              : undefined;
            useUIStore.getState().openTab(forceMoveData.channel_id, "voice", channelName, serverInfo);
          }
        });
        break;
      }
      case "voice_force_disconnect": {
        useVoiceStore.getState().handleForceDisconnect();
        break;
      }
      case "voice_afk_kick": {
        const afkData = msg.d as { channel_name: string; server_name: string };
        useVoiceStore.getState().handleAFKKick(afkData.channel_name, afkData.server_name);
        break;
      }
      case "voice_replaced": {
        useVoiceStore.getState().handleVoiceReplaced();
        break;
      }

      // ─── Pin Events ───
      case "message_pin":
        usePinStore.getState().handleMessagePin(msg.d as PinnedMessage);
        break;
      case "message_unpin":
        usePinStore.getState().handleMessageUnpin(
          msg.d as { message_id: string; channel_id: string }
        );
        break;

      // ─── Reaction Events ───
      case "reaction_update": {
        const reactionData = msg.d as {
          message_id: string;
          channel_id: string;
          reactions: ReactionGroup[];
          actor_id: string;
          message_author_id: string;
          added: boolean;
        };
        useMessageStore.getState().handleReactionUpdate(reactionData);

        // Notify when someone reacts to our message
        if (reactionData.added) {
          const myId = useAuthStore.getState().user?.id;
          const isMyMessage = reactionData.message_author_id === myId;
          const isSelfReaction = reactionData.actor_id === myId;

          if (isMyMessage && !isSelfReaction) {
            const uiState = useUIStore.getState();
            const panel = uiState.panels[uiState.activePanelId];
            const activeTab = panel?.tabs.find((tab) => tab.id === panel.activeTabId);
            const isViewingChannel =
              activeTab?.type === "text" && activeTab?.channelId === reactionData.channel_id;

            if (!isViewingChannel) {
              useReadStateStore.getState().incrementUnread(reactionData.channel_id);
              playNotificationSound();
            }
          }
        }
        break;
      }

      // ─── DM Events ───
      case "dm_channel_create":
        useDMStore.getState().handleDMChannelCreate(msg.d as DMChannelWithUser);
        break;
      case "dm_channel_update":
        useDMStore.getState().handleDMChannelUpdate(msg.d as DMChannelWithUser);
        break;
      case "dm_message_create": {
        let dmMsg = msg.d as DMMessage;
        const dmCurrentUserId = useAuthStore.getState().user?.id;

        // E2EE decryption
        if (dmMsg.encryption_version === 1 && dmMsg.ciphertext && dmMsg.sender_device_id) {
          const isOwnMessage = dmMsg.user_id === dmCurrentUserId;

          // Own messages: try pre-send cache first (sent from this device)
          let decrypted = false;
          if (isOwnMessage) {
            try {
              const cached = popSentPlaintext(dmMsg.dm_channel_id);
              if (cached) {
                dmMsg = {
                  ...dmMsg,
                  content: cached.content,
                  e2ee_file_keys: cached.file_keys,
                };
                decrypted = true;

                keyStorage.cacheDecryptedMessage({
                  messageId: dmMsg.id,
                  channelId: "",
                  dmChannelId: dmMsg.dm_channel_id,
                  content: cached.content,
                  timestamp: new Date(dmMsg.created_at).getTime(),
                }).catch(() => {});
              } else {
                // Fallback: check IndexedDB persisted cache
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

          // Cache miss or other user's message — decrypt via Signal Protocol
          if (!decrypted) {
            try {
              const payload = await decryptDMMessage(
                dmMsg.user_id,
                dmMsg.ciphertext!,
                dmMsg.sender_device_id!
              );
              if (payload) {
                dmMsg = {
                  ...dmMsg,
                  content: payload.content,
                  e2ee_file_keys: payload.file_keys,
                };

                if (payload.content) {
                  keyStorage.cacheDecryptedMessage({
                    messageId: dmMsg.id,
                    channelId: "",
                    dmChannelId: dmMsg.dm_channel_id,
                    content: payload.content,
                    timestamp: new Date(dmMsg.created_at).getTime(),
                  }).catch(() => {});
                }
              } else {
                // No envelope found — message may predate this device's registration
                dmMsg = { ...dmMsg, content: null };
              }
            } catch (err) {
              console.error("[ws] DM decrypt failed:", err);
              dmMsg = { ...dmMsg, content: null };
              useE2EEStore.getState().addDecryptionError({
                messageId: dmMsg.id,
                channelId: dmMsg.dm_channel_id,
                error: err instanceof Error ? err.message : "Decryption failed",
                timestamp: Date.now(),
              });
            }
          }
        }

        useDMStore.getState().handleDMMessageCreate(dmMsg);

        // Don't increment unread for own messages (server echoes to sender)
        if (dmMsg.user_id === dmCurrentUserId) break;

        // DM unread: increment if not viewing that DM tab
        const dmState = useDMStore.getState();
        const activeDMId = dmState.selectedDMId;
        if (dmMsg.dm_channel_id !== activeDMId) {
          dmState.incrementDMUnread(dmMsg.dm_channel_id);
          playNotificationSound();
          window.electronAPI?.flashFrame();
        }
        break;
      }
      case "dm_message_update": {
        let dmUpdateMsg = msg.d as DMMessage;
        const dmEditCurrentUserId = useAuthStore.getState().user?.id;

        // E2EE edit decryption
        if (dmUpdateMsg.encryption_version === 1 && dmUpdateMsg.ciphertext && dmUpdateMsg.sender_device_id) {
          const isOwnEdit = dmUpdateMsg.user_id === dmEditCurrentUserId;
          let editDecrypted = false;

          if (isOwnEdit) {
            try {
              const cached = popEditPlaintext(dmUpdateMsg.id);
              if (cached) {
                dmUpdateMsg = {
                  ...dmUpdateMsg,
                  content: cached.content,
                  e2ee_file_keys: cached.file_keys,
                };
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
                dmUpdateMsg.user_id,
                dmUpdateMsg.ciphertext!,
                dmUpdateMsg.sender_device_id!
              );
              dmUpdateMsg = {
                ...dmUpdateMsg,
                content: payload?.content ?? null,
                e2ee_file_keys: payload?.file_keys,
              };

              if (payload?.content) {
                keyStorage.cacheDecryptedMessage({
                  messageId: dmUpdateMsg.id,
                  channelId: "",
                  dmChannelId: dmUpdateMsg.dm_channel_id,
                  content: payload.content,
                  timestamp: new Date(dmUpdateMsg.created_at).getTime(),
                }).catch(() => {});
              }
            } catch (err) {
              console.error("[ws] DM edit decrypt failed:", err);
              dmUpdateMsg = { ...dmUpdateMsg, content: null };
            }
          }
        }

        useDMStore.getState().handleDMMessageUpdate(dmUpdateMsg);
        break;
      }
      case "dm_message_delete": {
        const dmDelData = msg.d as { id: string; dm_channel_id: string };

        const dmState = useDMStore.getState();
        const dmUnread = dmState.dmUnreadCounts[dmDelData.dm_channel_id] ?? 0;
        if (dmUnread > 0) {
          const dmMessages = dmState.messagesByChannel[dmDelData.dm_channel_id];
          const deletedDMMsg = dmMessages?.find((m) => m.id === dmDelData.id);
          const myId = useAuthStore.getState().user?.id;
          const isOwnDM = deletedDMMsg?.user_id === myId;
          if (!isOwnDM) {
            dmState.decrementDMUnread(dmDelData.dm_channel_id);
          }
        }

        dmState.handleDMMessageDelete(dmDelData);
        break;
      }

      // ─── DM Reaction Events ───
      case "dm_reaction_update": {
        const dmReactionData = msg.d as {
          dm_message_id: string;
          dm_channel_id: string;
          reactions: ReactionGroup[];
        };
        useDMStore.getState().handleDMReactionUpdate(dmReactionData);
        break;
      }

      // ─── DM Typing ───
      case "dm_typing_start": {
        const dmTypingData = msg.d as {
          user_id: string;
          username: string;
          dm_channel_id: string;
        };
        useDMStore.getState().handleDMTypingStart(
          dmTypingData.dm_channel_id,
          dmTypingData.username
        );
        break;
      }

      // ─── DM Pin Events ───
      case "dm_message_pin": {
        const dmPinData = msg.d as {
          dm_channel_id: string;
          message: DMMessage;
        };
        useDMStore.getState().handleDMMessagePin(dmPinData);
        break;
      }
      case "dm_message_unpin": {
        const dmUnpinData = msg.d as {
          dm_channel_id: string;
          message_id: string;
        };
        useDMStore.getState().handleDMMessageUnpin(dmUnpinData);
        break;
      }

      // ─── Channel Permission Events ───
      // Override changes may affect channel visibility (ViewChannel deny/allow)
      case "channel_permission_update": {
        useChannelPermissionStore
          .getState()
          .handleOverrideUpdate(msg.d as ChannelPermissionOverride);
        const cpUpd = msg.d as ChannelPermissionOverride;
        useChannelStore.getState().fetchChannels().then(() => {
          // Close text tab if channel is no longer visible after permission change
          const allVisible = useChannelStore.getState().categories.flatMap((c) => c.channels);
          if (!allVisible.some((ch) => ch.id === cpUpd.channel_id)) {
            useUIStore.getState().closeTextTabByChannel(cpUpd.channel_id);
          }
        });
        break;
      }
      case "channel_permission_delete": {
        const cpDel = msg.d as { channel_id: string; role_id: string };
        useChannelPermissionStore
          .getState()
          .handleOverrideDelete(cpDel.channel_id, cpDel.role_id);
        useChannelStore.getState().fetchChannels().then(() => {
          const allVisible = useChannelStore.getState().categories.flatMap((c) => c.channels);
          if (!allVisible.some((ch) => ch.id === cpDel.channel_id)) {
            useUIStore.getState().closeTextTabByChannel(cpDel.channel_id);
          }
        });
        break;
      }

      // ─── Friend Events ───
      case "friend_request_create":
        useFriendStore.getState().handleFriendRequestCreate(msg.d as FriendshipWithUser);
        break;
      case "friend_request_accept":
        useFriendStore.getState().handleFriendRequestAccept(msg.d as FriendshipWithUser);
        break;
      case "friend_request_decline":
        useFriendStore.getState().handleFriendRequestDecline(
          msg.d as { id: string; user_id: string }
        );
        break;
      case "friend_remove":
        useFriendStore.getState().handleFriendRemove(
          msg.d as { user_id: string }
        );
        break;

      // ─── DM Settings Events ───
      case "dm_settings_update":
        useDMStore.getState().handleDMSettingsUpdate(
          msg.d as { dm_channel_id: string; action: string }
        );
        break;

      // ─── Block Events ───
      case "user_block":
        useBlockStore.getState().handleUserBlock(
          msg.d as { user_id: string; blocked_user_id: string }
        );
        break;
      case "user_unblock":
        useBlockStore.getState().handleUserUnblock(
          msg.d as { user_id: string; unblocked_user_id: string }
        );
        break;

      // ─── P2P Call Events ───
      // Server acts as relay only — media flows directly between peers
      case "p2p_call_initiate":
        useP2PCallStore.getState().handleCallInitiate(msg.d as P2PCall);
        window.electronAPI?.flashFrame();
        break;
      case "p2p_call_accept":
        useP2PCallStore.getState().handleCallAccept(msg.d as { call_id: string });
        break;
      case "p2p_call_decline":
        useP2PCallStore.getState().handleCallDecline(msg.d as { call_id: string; reason?: string });
        break;
      case "p2p_call_end":
        useP2PCallStore.getState().handleCallEnd(
          msg.d as { call_id: string; reason?: string }
        );
        break;
      case "p2p_call_busy":
        useP2PCallStore.getState().handleCallBusy(msg.d as { receiver_id: string });
        break;
      case "p2p_signal":
        useP2PCallStore.getState().handleSignal(msg.d as P2PSignalPayload);
        break;

      // ─── Server Events ───
      case "server_update":
        useServerStore.getState().handleServerUpdate(msg.d as Server);
        break;
      case "server_create":
        useServerStore.getState().handleServerCreate(msg.d as ServerListItem);
        break;
      case "server_delete": {
        const deletedId = (msg.d as { id: string }).id;

        // Force-disconnect from voice if we were in a channel on this server
        if (useVoiceStore.getState().currentVoiceChannelId) {
          useVoiceStore.getState().handleForceDisconnect();
        }

        useServerStore.getState().handleServerDelete(deletedId);
        break;
      }

      // ─── E2EE Events ───
      case "prekey_low":
        useE2EEStore.getState().handlePrekeyLow();
        break;
      case "device_list_update":
        useE2EEStore.getState().fetchDevices();
        break;
      case "device_key_change":
        useE2EEStore.getState().fetchDevices();
        break;

      // ─── Badge Events ───
      case "badge_assign":
        useBadgeStore.getState().handleBadgeAssign(
          msg.d as { user_id: string; user_badge: import("../types").UserBadge }
        );
        break;
      case "badge_unassign":
        useBadgeStore.getState().handleBadgeUnassign(
          msg.d as { user_id: string; badge_id: string }
        );
        break;
    }
  }

  // Keep routeEventRef fresh every render (latest ref pattern)
  routeEventRef.current = routeEvent;

  function cleanupTimers() {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (tokenRefreshIntervalRef.current) {
      clearInterval(tokenRefreshIntervalRef.current);
      tokenRefreshIntervalRef.current = null;
    }
  }

  /** Fixed 10s reconnect delay. 5 attempts x 10s = 50s before giving up. */
  function getReconnectDelay(): number {
    return RECONNECT_DELAY;
  }

  /**
   * sendTyping — Called by MessageInput on keystroke.
   * Throttled: max once per 3s per channel.
   */
  const sendTyping = useCallback((channelId: string) => {
    const now = Date.now();
    const lastSent = lastTypingRef.current.get(channelId) ?? 0;

    if (now - lastSent < TYPING_THROTTLE) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "typing",
          d: { channel_id: channelId },
        })
      );
      lastTypingRef.current.set(channelId, now);
    }
  }, []);

  /** sendDMTyping — Same throttle as channel typing. */
  const sendDMTyping = useCallback((dmChannelId: string) => {
    const now = Date.now();
    const key = `dm:${dmChannelId}`;
    const lastSent = lastTypingRef.current.get(key) ?? 0;

    if (now - lastSent < TYPING_THROTTLE) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "dm_typing_start",
          d: { dm_channel_id: dmChannelId },
        })
      );
      lastTypingRef.current.set(key, now);
    }
  }, []);

  const sendVoiceJoin = useCallback((channelId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "voice_join",
          d: { channel_id: channelId },
        })
      );
    }
  }, []);

  const sendVoiceLeave = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "voice_leave",
        })
      );
    }
  }, []);

  /**
   * sendPresenceUpdate — Sends presence status via WS.
   * Called by idle detection and manual status picker.
   */
  const sendPresenceUpdate = useCallback((status: UserStatus) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          op: "presence_update",
          d: { status },
        })
      );
    }
  }, []);

  /** sendVoiceStateUpdate — Partial update: only changed fields are sent. */
  const sendVoiceStateUpdate = useCallback(
    (state: { is_muted?: boolean; is_deafened?: boolean; is_streaming?: boolean }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            op: "voice_state_update_request",
            d: state,
          })
        );
      }
    },
    []
  );

  /**
   * sendWS — Generic WS sender, used by P2P call store.
   * Single function instead of per-event helpers since store knows its own op codes.
   */
  const sendWS = useCallback((op: string, data?: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ op, d: data })
      );
    }
  }, []);

  // Register WS sender in P2P call store
  useP2PCallStore.getState().registerSendWS(sendWS);

  // ─── Effect: Mount/unmount lifecycle ───
  useEffect(() => {
    const myId = ++activeConnectionIdRef.current;

    /**
     * scheduleReconnect — Fixed 10s delay, max 5 attempts.
     * Shows "disconnected" banner after limit is reached.
     */
    function scheduleReconnect() {
      if (activeConnectionIdRef.current !== myId) return;

      if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setConnectionStatus("disconnected");
        return;
      }

      const delay = getReconnectDelay();
      reconnectAttemptRef.current++;
      setReconnectAttempt(reconnectAttemptRef.current);

      reconnectTimeoutRef.current = setTimeout(() => {
        if (activeConnectionIdRef.current === myId) {
          doConnect();
        }
      }, delay);
    }

    /**
     * doConnect — Establishes WS connection within this effect scope.
     * Refreshes token before connecting (WS has no 401 retry mechanism).
     */
    async function doConnect() {
      if (activeConnectionIdRef.current !== myId) return;

      setConnectionStatus("connecting");

      let token: string | null = null;
      try {
        token = await ensureFreshToken();
      } catch {
        // Server may be down — network error on refresh
      }

      if (activeConnectionIdRef.current !== myId) return;

      if (!token) {
        scheduleReconnect();
        return;
      }

      cleanupTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      // Include pref_status in WS URL for immediate correct status broadcast on connect
      const prefStatus = useAuthStore.getState().manualStatus;
      const socket = new WebSocket(`${WS_URL}?token=${token}&pref_status=${prefStatus}`);
      wsRef.current = socket;

      // ─── onopen ───
      socket.onopen = () => {
        if (activeConnectionIdRef.current !== myId) return;

        reconnectAttemptRef.current = 0;
        setReconnectAttempt(0);
        missedHeartbeatsRef.current = 0;

        // Start heartbeat interval
        heartbeatIntervalRef.current = setInterval(() => {
          if (activeConnectionIdRef.current !== myId) {
            clearInterval(heartbeatIntervalRef.current!);
            return;
          }

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "heartbeat" }));
            missedHeartbeatsRef.current++;

            if (missedHeartbeatsRef.current >= WS_HEARTBEAT_MAX_MISS) {
              socket.close();
            }
          }
        }, WS_HEARTBEAT_INTERVAL);

        // Proactive token refresh every 10min while WS is open.
        // Access token expires at 15min — 10min gives 5min buffer.
        // On failure, retries every 10s (up to 9 times) for smooth recovery.
        const TOKEN_REFRESH_INTERVAL = 10 * 60 * 1000;
        const TOKEN_REFRESH_RETRY_DELAY = 10_000;
        const TOKEN_REFRESH_MAX_RETRIES = 9;

        tokenRefreshIntervalRef.current = setInterval(async () => {
          if (activeConnectionIdRef.current !== myId) {
            clearInterval(tokenRefreshIntervalRef.current!);
            return;
          }

          for (let attempt = 0; attempt < TOKEN_REFRESH_MAX_RETRIES; attempt++) {
            try {
              await ensureFreshToken();
              break;
            } catch {
              console.warn(`[useWebSocket] Token refresh attempt ${attempt + 1} failed`);
              if (attempt < TOKEN_REFRESH_MAX_RETRIES - 1) {
                await new Promise((r) => setTimeout(r, TOKEN_REFRESH_RETRY_DELAY));
                if (activeConnectionIdRef.current !== myId) return;
              }
            }
          }
        }, TOKEN_REFRESH_INTERVAL);
      };

      // ─── onmessage ───
      socket.onmessage = (event: MessageEvent) => {
        if (activeConnectionIdRef.current !== myId) return;

        let msg: WSMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (msg.seq) {
          lastSeqRef.current = msg.seq;
        }

        // Route via ref for closure freshness
        routeEventRef.current(msg);
      };

      // ─── onclose ───
      socket.onclose = () => {
        // Stale socket guard — critical for StrictMode
        if (activeConnectionIdRef.current !== myId) return;

        setConnectionStatus("disconnected");
        cleanupTimers();
        scheduleReconnect();
      };

      // ─── onerror ───
      socket.onerror = () => {
        // onclose will fire — no additional handling needed
      };
    }

    doConnect();

    return () => {
      // Increment (not reset) to invalidate all callbacks from this connection
      activeConnectionIdRef.current++;
      cleanupTimers();

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return { sendTyping, sendDMTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate, sendWS, connectionStatus, reconnectAttempt };
}
