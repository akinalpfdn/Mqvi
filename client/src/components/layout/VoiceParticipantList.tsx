import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import { useUIStore, type TabServerInfo } from "../../stores/uiStore";
import Avatar from "../shared/Avatar";
import type { VoiceState, User } from "../../types";

type VoiceParticipantListProps = {
  participants: VoiceState[];
  channelId: string;
  channelName: string;
  canMoveMembers: boolean;
  draggingVoiceUserId: string | null;
  onDragStart: (e: React.DragEvent, userId: string, channelId: string) => void;
  onDragEnd: () => void;
  onContextMenu: (data: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    x: number;
    y: number;
  }) => void;
  onShowUserCard: (user: User, top: number, left: number) => void;
  getActiveServerInfo: () => TabServerInfo | undefined;
};

function VoiceParticipantList({
  participants,
  channelId,
  channelName,
  canMoveMembers,
  draggingVoiceUserId,
  onDragStart,
  onDragEnd,
  onContextMenu,
  onShowUserCard,
  getActiveServerInfo,
}: VoiceParticipantListProps) {
  const { t: tVoice } = useTranslation("voice");
  const currentUser = useAuthStore((s) => s.user);
  const localMutedUsers = useVoiceStore((s) => s.localMutedUsers);
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const screenShareViewers = useVoiceStore((s) => s.screenShareViewers);
  const toggleWatchScreenShare = useVoiceStore((s) => s.toggleWatchScreenShare);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const openTab = useUIStore((s) => s.openTab);

  return (
    <div className="ch-tree-voice-users">
      {participants.map((p) => {
        const isMe = p.user_id === currentUser?.id;
        const isLocalMuted = localMutedUsers[p.user_id] ?? false;
        const isSpeaking = activeSpeakers[p.user_id] ?? false;

        return (
          <div
            key={p.user_id}
            className={`ch-tree-voice-user${isSpeaking ? " speaking" : ""}${draggingVoiceUserId === p.user_id ? " vu-dragging" : ""}`}
            draggable={isMe || canMoveMembers}
            onDragStart={(e) => onDragStart(e, p.user_id, channelId)}
            onDragEnd={onDragEnd}
            title={(isMe || canMoveMembers) ? tVoice("dragToMove") : undefined}
            onContextMenu={(e) => {
              if (isMe) return;
              e.preventDefault();
              e.stopPropagation();
              onContextMenu({
                userId: p.user_id,
                username: p.username,
                displayName: p.display_name,
                avatarUrl: p.avatar_url,
                x: e.clientX,
                y: e.clientY,
              });
            }}
          >
            <button
              className="ch-tree-vu-avatar-btn"
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onShowUserCard(
                  {
                    id: p.user_id,
                    username: p.username,
                    display_name: p.display_name || null,
                    avatar_url: p.avatar_url || null,
                    status: "online" as const,
                    custom_status: null,
                    email: null,
                    language: "en",
                    is_platform_admin: false,
                    has_seen_download_prompt: false,
                    has_seen_welcome: false,
                    dm_privacy: "message_request" as const,
                    created_at: new Date().toISOString(),
                  },
                  rect.top,
                  rect.right + 8
                );
              }}
            >
              <Avatar
                name={p.display_name || p.username}
                avatarUrl={p.avatar_url}
                size={22}
                isCircle
              />
            </button>
            <span className="ch-tree-vu-name">{p.display_name || p.username}</span>
            <span className="ch-tree-vu-icons">
              {p.is_server_deafened && (
                <svg className="ch-tree-vu-icon ch-tree-vu-server-deafen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-label={tVoice("serverDeafened")}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                </svg>
              )}
              {p.is_server_muted && (
                <svg className="ch-tree-vu-icon ch-tree-vu-server-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-label={tVoice("serverMuted")}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                </svg>
              )}
              {!isMe && isLocalMuted && (
                <svg className="ch-tree-vu-icon ch-tree-vu-local-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-label={tVoice("localMuted")}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                </svg>
              )}
              {p.is_streaming && (
                <>
                  <button
                    className={`ch-tree-vu-icon ch-tree-vu-stream${watchingScreenShares[p.user_id] ? " watching" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const wasWatching = watchingScreenShares[p.user_id];
                      toggleWatchScreenShare(p.user_id);
                      if (!wasWatching && currentVoiceChannelId) {
                        openTab(currentVoiceChannelId, "voice", channelName, getActiveServerInfo());
                      }
                    }}
                    title={watchingScreenShares[p.user_id] ? tVoice("stopWatching") : tVoice("watchScreenShare")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  </button>
                  {screenShareViewers[p.user_id] > 0 && (
                    <span className="ch-tree-vu-viewer-count">
                      {screenShareViewers[p.user_id]}
                    </span>
                  )}
                </>
              )}
              {p.is_deafened ? (
                <svg className="ch-tree-vu-icon ch-tree-vu-deafen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                </svg>
              ) : p.is_muted ? (
                <svg className="ch-tree-vu-icon ch-tree-vu-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-label={tVoice("muted")}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                </svg>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default VoiceParticipantList;
