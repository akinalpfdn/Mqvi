/**
 * System-domain WS event handlers.
 * Handles: ready, presence, members, roles, servers, friends, blocks, P2P calls, E2EE, badges.
 */

import { useChannelStore } from "../../stores/channelStore";
import { useMessageStore } from "../../stores/messageStore";
import { useMemberStore } from "../../stores/memberStore";
import { useRoleStore } from "../../stores/roleStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useServerStore } from "../../stores/serverStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useAuthStore } from "../../stores/authStore";
import { useDMStore } from "../../stores/dmStore";
import { useFriendStore } from "../../stores/friendStore";
import { useBlockStore } from "../../stores/blockStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useBadgeStore } from "../../stores/badgeStore";
import type {
  WSMessage,
  MemberWithRoles,
  Role,
  Server,
  ServerListItem,
  UserStatus,
  FriendshipWithUser,
  P2PCall,
  P2PSignalPayload,
} from "../../types";
import type { WSHandlerContext } from "./types";

export async function handleSystemEvent(
  msg: WSMessage,
  ctx: WSHandlerContext,
  setConnectionStatus: (s: "connected" | "connecting" | "disconnected") => void
): Promise<boolean> {
  switch (msg.op) {
    case "heartbeat_ack":
      // Handled inline in useWebSocket (missedHeartbeatsRef reset)
      return true;

    case "ready": {
      const data = msg.d as {
        online_user_ids: string[];
        servers: ServerListItem[];
        muted_server_ids: string[];
        muted_channel_ids: string[];
        pref_status: string;
      };

      if (data.servers) useServerStore.getState().setServersFromReady(data.servers);
      if (data.muted_server_ids) useServerStore.getState().setMutedServersFromReady(data.muted_server_ids);
      if (data.muted_channel_ids) useChannelStore.getState().setMutedChannelsFromReady(data.muted_channel_ids);
      if (data.pref_status) useAuthStore.getState().setManualStatus(data.pref_status as UserStatus);

      useMemberStore.getState().handleReady(data.online_user_ids);
      useReadStateStore.getState().fetchAllUnreadCounts();
      useDMStore.getState().fetchChannels();
      useDMStore.getState().fetchDMSettings();
      useFriendStore.getState().fetchFriends();
      useFriendStore.getState().fetchRequests();
      useBlockStore.getState().fetchBlocked();

      setConnectionStatus("connected");

      // Voice auto-rejoin
      {
        const voiceState = useVoiceStore.getState();
        const previousChannel = voiceState.currentVoiceChannelId;
        if (previousChannel) {
          voiceState.leaveVoiceChannel();
          voiceState.joinVoiceChannel(previousChannel).then((tokenResp) => {
            if (tokenResp) {
              ctx.sendVoiceJoin(previousChannel);
            } else {
              console.warn("[useWebSocket] Voice auto-rejoin failed — user needs to rejoin manually");
            }
          });
        }
      }
      return true;
    }

    case "presence_update": {
      const data = msg.d as { user_id: string; status: UserStatus };
      useMemberStore.getState().handlePresenceUpdate(data.user_id, data.status);
      const myId = useAuthStore.getState().user?.id;
      if (data.user_id === myId) {
        useAuthStore.getState().updateUser({ status: data.status });
      }
      return true;
    }

    case "member_join":
      useMemberStore.getState().handleMemberJoin(msg.d as MemberWithRoles);
      return true;
    case "member_leave":
      useMemberStore.getState().handleMemberLeave((msg.d as { user_id: string }).user_id);
      return true;
    case "member_update": {
      const updatedMember = msg.d as MemberWithRoles;
      useMemberStore.getState().handleMemberUpdate(updatedMember);
      useVoiceStore.getState().updateUserInfo(
        updatedMember.id,
        updatedMember.display_name ?? updatedMember.username,
        updatedMember.avatar_url ?? "",
      );
      const authorPatch = {
        display_name: updatedMember.display_name,
        avatar_url: updatedMember.avatar_url,
      };
      useMessageStore.getState().handleAuthorUpdate(updatedMember.id, authorPatch);
      useDMStore.getState().handleDMAuthorUpdate(updatedMember.id, authorPatch);
      const myUserId = useAuthStore.getState().user?.id;
      if (updatedMember.id === myUserId) {
        useChannelStore.getState().fetchChannels();
      }
      return true;
    }

    // ─── Roles ───
    case "role_create": {
      const role = msg.d as Role;
      useMemberStore.getState().handleRoleCreate(role);
      useRoleStore.getState().handleRoleCreate(role);
      return true;
    }
    case "role_update": {
      const role = msg.d as Role;
      useMemberStore.getState().handleRoleUpdate(role);
      useRoleStore.getState().handleRoleUpdate(role);
      useChannelStore.getState().fetchChannels();
      return true;
    }
    case "role_delete": {
      const roleId = (msg.d as { id: string }).id;
      useMemberStore.getState().handleRoleDelete(roleId);
      useRoleStore.getState().handleRoleDelete(roleId);
      useChannelStore.getState().fetchChannels();
      return true;
    }
    case "roles_reorder": {
      const roles = msg.d as Role[];
      useRoleStore.getState().handleRolesReorder(roles);
      useMemberStore.getState().handleRolesReorder(roles);
      return true;
    }

    // ─── Servers ───
    case "server_update":
      useServerStore.getState().handleServerUpdate(msg.d as Server);
      return true;
    case "server_create":
      useServerStore.getState().handleServerCreate(msg.d as ServerListItem);
      return true;
    case "server_delete": {
      const deletedId = (msg.d as { id: string }).id;
      if (useVoiceStore.getState().currentVoiceChannelId) {
        useVoiceStore.getState().handleForceDisconnect();
      }
      useServerStore.getState().handleServerDelete(deletedId);
      return true;
    }

    // ─── Friends ───
    case "friend_request_create":
      useFriendStore.getState().handleFriendRequestCreate(msg.d as FriendshipWithUser);
      return true;
    case "friend_request_accept":
      useFriendStore.getState().handleFriendRequestAccept(msg.d as FriendshipWithUser);
      return true;
    case "friend_request_decline":
      useFriendStore.getState().handleFriendRequestDecline(msg.d as { id: string; user_id: string });
      return true;
    case "friend_remove":
      useFriendStore.getState().handleFriendRemove(msg.d as { user_id: string });
      return true;

    // ─── Blocks ───
    case "user_block":
      useBlockStore.getState().handleUserBlock(msg.d as { user_id: string; blocked_user_id: string });
      return true;
    case "user_unblock":
      useBlockStore.getState().handleUserUnblock(msg.d as { user_id: string; unblocked_user_id: string });
      return true;

    // ─── P2P Calls ───
    case "p2p_call_initiate":
      useP2PCallStore.getState().handleCallInitiate(msg.d as P2PCall);
      window.electronAPI?.flashFrame();
      return true;
    case "p2p_call_accept":
      useP2PCallStore.getState().handleCallAccept(msg.d as { call_id: string });
      return true;
    case "p2p_call_decline":
      useP2PCallStore.getState().handleCallDecline(msg.d as { call_id: string; reason?: string });
      return true;
    case "p2p_call_end":
      useP2PCallStore.getState().handleCallEnd(msg.d as { call_id: string; reason?: string });
      return true;
    case "p2p_call_busy":
      useP2PCallStore.getState().handleCallBusy(msg.d as { receiver_id: string });
      return true;
    case "p2p_signal":
      useP2PCallStore.getState().handleSignal(msg.d as P2PSignalPayload);
      return true;

    // ─── E2EE ───
    case "prekey_low":
      useE2EEStore.getState().handlePrekeyLow();
      return true;
    case "device_list_update":
    case "device_key_change":
      useE2EEStore.getState().fetchDevices();
      return true;

    // ─── Badges ───
    case "badge_assign":
      useBadgeStore.getState().handleBadgeAssign(
        msg.d as { user_id: string; user_badge: import("../../types").UserBadge }
      );
      return true;
    case "badge_unassign":
      useBadgeStore.getState().handleBadgeUnassign(msg.d as { user_id: string; badge_id: string });
      return true;

    default:
      return false;
  }
}
