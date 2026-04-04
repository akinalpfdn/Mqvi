/**
 * DMSection — Collapsible DM list in the sidebar channel tree.
 * Shows DM channels with unread counts, pin/mute indicators, and context menu.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useDMStore } from "../../stores/dmStore";
import { useFriendStore } from "../../stores/friendStore";
import { useBlockStore } from "../../stores/blockStore";
import { useUIStore } from "../../stores/uiStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useToastStore } from "../../stores/toastStore";
import { copyToClipboard } from "../../utils/constants";
import Avatar from "../shared/Avatar";
import ContextMenu from "../shared/ContextMenu";
import DMMuteDurationPicker from "../dm/DMMuteDurationPicker";
import ReportModal from "../shared/ReportModal";
import { useContextMenu, type ContextMenuItem } from "../../hooks/useContextMenu";
import { useConfirm } from "../../hooks/useConfirm";
import { useAuthStore } from "../../stores/authStore";
import type { DMChannelWithUser, User } from "../../types";

type DMSectionProps = {
  onShowUserCard: (user: User, top: number, left: number) => void;
};

function DMSection({ onShowUserCard }: DMSectionProps) {
  const { t } = useTranslation("common");
  const { t: tDM } = useTranslation("dm");
  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandedSections = useSidebarStore((s) => s.expandedSections);
  const openTab = useUIStore((s) => s.openTab);
  const addToast = useToastStore((s) => s.addToast);
  const confirmDialog = useConfirm();

  const dmChannels = useDMStore((s) => s.channels);
  const selectedDMId = useDMStore((s) => s.selectedDMId);
  const selectDM = useDMStore((s) => s.selectDM);
  const dmUnreadCounts = useDMStore((s) => s.dmUnreadCounts);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const hideDM = useDMStore((s) => s.hideDM);
  const pinDM = useDMStore((s) => s.pinDM);
  const unpinDM = useDMStore((s) => s.unpinDM);
  const unmuteDM = useDMStore((s) => s.unmuteDM);
  const setPendingSearchChannelId = useDMStore((s) => s.setPendingSearchChannelId);

  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);
  const sendFriendRequest = useFriendStore((s) => s.sendRequest);
  const removeFriend = useFriendStore((s) => s.removeFriend);
  const acceptFriendRequest = useFriendStore((s) => s.acceptRequest);
  const declineFriendRequest = useFriendStore((s) => s.declineRequest);
  const isBlocked = useBlockStore((s) => s.isBlocked);
  const blockUser = useBlockStore((s) => s.blockUser);
  const unblockUser = useBlockStore((s) => s.unblockUser);
  const initiateCall = useP2PCallStore((s) => s.initiateCall);

  const { menuState, openMenu, closeMenu } = useContextMenu();

  const [mutePicker, setMutePicker] = useState<{
    channelId: string; x: number; y: number;
  } | null>(null);

  const [reportTarget, setReportTarget] = useState<{
    userId: string; username: string;
  } | null>(null);

  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isExpanded = expandedSections["dms"] ?? true;

  const acceptedChannels = dmChannels.filter((dm) => dm.status !== "pending");
  const pendingChannels = dmChannels.filter(
    (dm) => dm.status === "pending" && dm.initiated_by !== currentUserId
  );
  const pendingOutgoing = dmChannels.filter(
    (dm) => dm.status === "pending" && dm.initiated_by === currentUserId
  );

  function handleDMClick(dmId: string, userName: string) {
    selectDM(dmId);
    openTab(dmId, "dm", userName);
    clearDMUnread(dmId);
    fetchMessages(dmId);
    closeAllDrawers();
  }

  function handleDMContextMenu(e: React.MouseEvent, dm: DMChannelWithUser) {
    const user = dm.other_user;
    const name = user.display_name || user.username;
    const unread = dmUnreadCounts[dm.id] ?? 0;
    const blocked = isBlocked(user.id);
    const isFriend = friends.some((f) => f.user_id === user.id);
    const outReq = outgoing.find((r) => r.user_id === user.id);
    const inReq = incoming.find((r) => r.user_id === user.id);

    const items: ContextMenuItem[] = [
      {
        label: tDM("viewProfile"),
        onClick: () => {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          onShowUserCard(user, rect.top, rect.right + 8);
        },
      },
      {
        label: tDM("voiceCall"),
        onClick: () => initiateCall(user.id, "voice"),
      },
      {
        label: tDM("videoCall"),
        onClick: () => initiateCall(user.id, "video"),
      },
      {
        label: tDM("searchInMessages"),
        onClick: () => {
          handleDMClick(dm.id, name);
          setPendingSearchChannelId(dm.id);
        },
        separator: true,
      },
      {
        label: tDM("markAsRead"),
        onClick: () => clearDMUnread(dm.id),
        disabled: unread === 0,
      },
      {
        label: dm.is_pinned ? tDM("unpinConversation") : tDM("pinConversation"),
        onClick: () => {
          if (dm.is_pinned) unpinDM(dm.id);
          else pinDM(dm.id);
        },
      },
      {
        label: dm.is_muted ? tDM("unmuteDM") : tDM("muteDM"),
        onClick: () => {
          if (dm.is_muted) unmuteDM(dm.id);
          else setMutePicker({ channelId: dm.id, x: e.clientX, y: e.clientY });
        },
      },
      {
        label: tDM("closeDM"),
        onClick: () => hideDM(dm.id),
        separator: true,
      },
    ];

    // Friend status actions
    if (isFriend) {
      items.push({
        label: tDM("removeFriend"),
        onClick: () => removeFriend(user.id),
        danger: true,
        separator: true,
      });
    } else if (inReq) {
      items.push({
        label: tDM("acceptRequest"),
        onClick: () => acceptFriendRequest(inReq.id),
        separator: true,
      });
    } else if (outReq) {
      items.push({
        label: tDM("cancelRequest"),
        onClick: () => declineFriendRequest(outReq.id),
        separator: true,
      });
    } else {
      items.push({
        label: tDM("addFriend"),
        onClick: () => {
          sendFriendRequest(user.username);
          addToast("success", tDM("friendRequestSent"));
        },
        separator: true,
      });
    }

    // Block / Unblock
    if (blocked) {
      items.push({
        label: tDM("unblockUser"),
        onClick: () => unblockUser(user.id),
      });
    } else {
      items.push({
        label: tDM("blockUser"),
        onClick: async () => {
          const ok = await confirmDialog({
            title: tDM("blockConfirmTitle", { username: name }),
            message: tDM("blockConfirmMessage"),
            confirmLabel: tDM("blockConfirmButton"),
            danger: true,
          });
          if (ok) blockUser(user.id);
        },
        danger: true,
      });
    }

    // Report
    items.push({
      label: tDM("reportUser"),
      onClick: () => setReportTarget({ userId: user.id, username: name }),
      danger: true,
    });

    // Copy User ID
    items.push({
      label: tDM("copyUserId"),
      onClick: async () => {
        await copyToClipboard(user.id);
        addToast("success", tDM("userIdCopied"));
      },
      separator: true,
    });

    openMenu(e, items);
  }

  return (
    <>
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("dms")}
        >
          <span className={`ch-tree-chevron${isExpanded ? " expanded" : ""}`}>&#x276F;</span>
          <span>{t("directMessages")}</span>
        </button>

        {isExpanded && (
          <div className="ch-tree-section-body">
            {/* ── Message Requests ── */}
            {pendingChannels.length > 0 && (
              <div className="ch-tree-dm-requests">
                <span className="ch-tree-dm-requests-label">
                  {tDM("messageRequests")}
                  <span className="ch-tree-badge">{pendingChannels.length}</span>
                </span>
                {pendingChannels.map((dm) => {
                  const isActive = dm.id === selectedDMId;
                  const name = dm.other_user.display_name || dm.other_user.username;
                  return (
                    <button
                      key={dm.id}
                      className={`ch-tree-item ch-tree-dm ch-tree-dm--pending${isActive ? " active" : ""}`}
                      onClick={() => handleDMClick(dm.id, name)}
                    >
                      <Avatar name={name} avatarUrl={dm.other_user.avatar_url} size={24} isCircle />
                      <span className="ch-tree-label">{name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {/* ── Normal DMs + outgoing pending ── */}
            {[...acceptedChannels, ...pendingOutgoing].length === 0 && pendingChannels.length === 0 ? (
              <div className="ch-tree-placeholder">
                <span className="ch-tree-placeholder-text">—</span>
              </div>
            ) : (
              [...acceptedChannels, ...pendingOutgoing].map((dm) => {
                const isActive = dm.id === selectedDMId;
                const unread = dmUnreadCounts[dm.id] ?? 0;
                const name = dm.other_user.display_name || dm.other_user.username;

                return (
                  <button
                    key={dm.id}
                    className={`ch-tree-item ch-tree-dm${isActive ? " active" : ""}${unread > 0 ? " has-unread" : ""}${dm.is_muted ? " muted" : ""}`}
                    onClick={() => handleDMClick(dm.id, name)}
                    onContextMenu={(e) => handleDMContextMenu(e, dm)}
                  >
                    <Avatar
                      name={name}
                      avatarUrl={dm.other_user.avatar_url}
                      size={24}
                      isCircle
                    />
                    <span className="ch-tree-label">{name}</span>
                    <span className="ch-tree-dm-indicators">
                      {dm.is_pinned && (
                        <svg className="ch-tree-dm-pin-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" strokeWidth={2} aria-label={tDM("pinConversation")}>
                          <title>{tDM("pinConversation")}</title>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
                        </svg>
                      )}
                      {dm.is_muted && (
                        <svg className="ch-tree-dm-mute-icon" viewBox="0 0 16 16" width="14" height="14" aria-label={tDM("muteDM")}>
                          <title>{tDM("muteDM")}</title>
                          <path fill="currentColor" d="M12 3.5L7.5 7H4v3h3.5L12 13.5V3.5zM13.5 1L2 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      )}
                      {unread > 0 && <span className="ch-tree-badge">{unread}</span>}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      <ContextMenu state={menuState} onClose={closeMenu} />

      {mutePicker && (
        <DMMuteDurationPicker
          channelId={mutePicker.channelId}
          x={mutePicker.x}
          y={mutePicker.y}
          onClose={() => setMutePicker(null)}
        />
      )}

      {reportTarget && (
        <ReportModal
          userId={reportTarget.userId}
          username={reportTarget.username}
          onClose={() => setReportTarget(null)}
        />
      )}
    </>
  );
}

export default DMSection;
