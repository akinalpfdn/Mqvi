/**
 * Voice-domain WS event handlers.
 * Handles: voice state, screen share, force move/disconnect, AFK kick, voice replaced.
 */

import { useVoiceStore } from "../../stores/voiceStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useAuthStore } from "../../stores/authStore";
import { useUIStore } from "../../stores/uiStore";
import { useVoiceMessageStore } from "../../stores/voiceMessageStore";
import { playJoinSound, playLeaveSound } from "../../utils/sounds";
import type { WSMessage, VoiceState, VoiceStateUpdateData, VoiceMessage } from "../../types";
import type { WSHandlerContext } from "./types";
import { isVoiceRecoveryAllowed } from "../../stores/shared/voiceRecovery";

export async function handleVoiceEvent(
  msg: WSMessage,
  ctx: WSHandlerContext
): Promise<boolean> {
  switch (msg.op) {
    case "voice_state_update": {
      const voiceData = msg.d as VoiceStateUpdateData;
      const voiceState = useVoiceStore.getState();

      const prevStates = voiceState.voiceStates[voiceData.channel_id] ?? [];
      const prevStreaming = prevStates.find((s) => s.user_id === voiceData.user_id)?.is_streaming ?? false;
      const myUserId = useAuthStore.getState().user?.id;
      voiceState.handleVoiceStateUpdate(voiceData);

      const isMe = voiceData.user_id === myUserId;
      const myChannelId = voiceState.currentVoiceChannelId;
      const isSameChannel = myChannelId && myChannelId === voiceData.channel_id;

      if (isSameChannel || isMe) {
        if (voiceData.action === "join") playJoinSound();
        else if (voiceData.action === "leave") playLeaveSound();
      }

      if (isSameChannel && !isMe && voiceData.action === "update") {
        if (!prevStreaming && voiceData.is_streaming) playJoinSound();
        else if (prevStreaming && !voiceData.is_streaming) playLeaveSound();
      }

      // Enforce server mute/deafen on self — update store so VoiceStateManager syncs to LiveKit
      if (isMe && voiceData.action === "update") {
        useVoiceStore.setState({
          isServerMuted: voiceData.is_server_muted,
          isServerDeafened: voiceData.is_server_deafened,
        });
      }
      return true;
    }

    case "screen_share_viewer_update": {
      const viewerData = msg.d as {
        streamer_user_id: string; channel_id: string;
        viewer_count: number; viewer_user_id: string; action: string;
      };
      useVoiceStore.getState().handleScreenShareViewerUpdate(viewerData);

      const myId = useAuthStore.getState().user?.id;
      if (myId === viewerData.streamer_user_id) {
        if (viewerData.action === "join") playJoinSound();
        else if (viewerData.action === "leave") playLeaveSound();
      }
      return true;
    }

    case "voice_states_sync": {
      const syncData = msg.d as { states: VoiceState[]; channel_timers?: Record<string, number> };
      const vs = useVoiceStore.getState();
      vs.handleVoiceStatesSync(syncData.states);
      vs.applyChannelTimers(syncData.channel_timers ?? {});

      const myId = useAuthStore.getState().user?.id;
      if (!myId) return true;

      const myVoiceChannel = vs.currentVoiceChannelId;
      const selfEntry = syncData.states.find((s) => s.user_id === myId);
      const liveKitStillConnected = !!vs.livekitToken;

      console.warn("[ws] voice_states_sync handler", {
        timestamp: new Date().toISOString(),
        myVoiceChannel,
        selfEntryChannel: selfEntry?.channel_id,
        liveKitStillConnected,
        willReassert: !!(myVoiceChannel && selfEntry?.channel_id !== myVoiceChannel),
        willRecover: !myVoiceChannel && !!selfEntry,
      });

      if (myVoiceChannel) {
        // Client thinks it's in voice — re-assert if server doesn't agree.
        // Server's JoinChannel has a same-channel rejoin path that silently
        // refreshes state (no broadcast, no leave/join sounds). Always safe
        // to re-assert regardless of LiveKit connection state.
        const matches = selfEntry?.channel_id === myVoiceChannel;
        if (!matches) {
          console.warn("[ws] voice_states_sync RE-ASSERT sendVoiceJoin", { channel: myVoiceChannel, liveKitStillConnected });
          ctx.sendVoiceJoin(myVoiceChannel);
        }
      } else if (selfEntry) {
        // F5 recovery: backend still has us in voice (within the 35s orphan
        // grace) but our in-memory state was wiped by the reload. Re-acquire
        // a LiveKit token and resume — other users never saw us leave.
        // Tab-scoped flag check: only the ORIGINAL tab that joined voice should
        // auto-recover. A fresh tab/window must never claim voice just because
        // the backend still remembers the user being in voice from another tab.
        const recoveryAllowed = isVoiceRecoveryAllowed(selfEntry.channel_id);
        if (!recoveryAllowed) {
          console.warn("[ws] voice_states_sync F5 RECOVERY skipped — not the owning tab", { channel: selfEntry.channel_id });
          return true;
        }
        console.warn("[ws] voice_states_sync F5 RECOVERY path", { channel: selfEntry.channel_id });
        void (async () => {
          // joinVoiceChannel scopes the token request to activeServerId;
          // jump to the correct server first if different.
          if (selfEntry.server_id) {
            const srvStore = useServerStore.getState();
            if (srvStore.activeServerId !== selfEntry.server_id) {
              srvStore.setActiveServer(selfEntry.server_id);
            }
          }
          const tokenResp = await vs.joinVoiceChannel(selfEntry.channel_id);
          if (tokenResp) {
            ctx.sendVoiceJoin(selfEntry.channel_id);
          }
        })();
      }
      return true;
    }

    case "voice_server_states_sync": {
      // Visibility changed in one server: replace only its states. No re-assert or recovery here —
      // the user's own channel is always included, and the other servers are untouched.
      const d = msg.d as { server_id: string; states: VoiceState[]; channel_timers?: Record<string, number> };
      useVoiceStore.getState().handleVoiceServerStatesSync(d.server_id, d.states, d.channel_timers ?? {});
      return true;
    }

    case "voice_channel_timer_start": {
      const d = msg.d as { channel_id: string; started_at: number };
      useVoiceStore.getState().handleVoiceChannelTimerStart(d.channel_id, d.started_at);
      return true;
    }

    case "voice_channel_timer_stop": {
      const d = msg.d as { channel_id: string };
      useVoiceStore.getState().handleVoiceChannelTimerStop(d.channel_id);
      // Channel is now empty → ephemeral chat for it is wiped server-side, mirror locally.
      useVoiceMessageStore.getState().wipeChannel(d.channel_id);
      return true;
    }

    case "voice_message_create": {
      const d = msg.d as VoiceMessage;
      useVoiceMessageStore.getState().append(d);
      return true;
    }

    case "voice_message_update": {
      const d = msg.d as VoiceMessage;
      useVoiceMessageStore.getState().update(d);
      return true;
    }

    case "voice_message_delete": {
      const d = msg.d as { id: string; channel_id: string };
      useVoiceMessageStore.getState().remove(d.channel_id, d.id);
      return true;
    }

    case "voice_force_move": {
      const forceMoveData = msg.d as { channel_id: string; channel_name?: string };
      const voiceStore = useVoiceStore.getState();

      // Preserve user's mute/deafen state across the move
      const prevMuted = voiceStore.isMuted;
      const prevDeafened = voiceStore.isDeafened;

      voiceStore.leaveVoiceChannel();
      voiceStore.joinVoiceChannel(forceMoveData.channel_id).then((tokenResp) => {
        if (tokenResp) {
          // Restore mute/deafen state that was cleared by leave+join cycle
          useVoiceStore.setState({ isMuted: prevMuted, isDeafened: prevDeafened });
          ctx.sendVoiceJoin(forceMoveData.channel_id);

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
      return true;
    }

    case "voice_force_disconnect":
      console.warn("[ws] voice_force_disconnect RECEIVED", { timestamp: new Date().toISOString() });
      useVoiceStore.getState().handleForceDisconnect();
      return true;

    case "voice_afk_kick": {
      console.warn("[ws] voice_afk_kick RECEIVED", { timestamp: new Date().toISOString() });
      const afkData = msg.d as { channel_name: string; server_name: string };
      useVoiceStore.getState().handleAFKKick(afkData.channel_name, afkData.server_name);
      return true;
    }

    case "voice_replaced":
      console.warn("[ws] voice_replaced RECEIVED", { timestamp: new Date().toISOString() });
      useVoiceStore.getState().handleVoiceReplaced();
      return true;

    default:
      return false;
  }
}
