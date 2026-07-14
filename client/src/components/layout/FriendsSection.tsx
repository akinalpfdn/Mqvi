/**
 * FriendsSection — Collapsible friends list in the sidebar channel tree.
 * Shows online friends (scrollable) with context menu for profile, calls, DM.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useFriendStore } from "../../stores/friendStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import Avatar from "../shared/Avatar";
import { IconFriends } from "../shared/Icons";
import ContextMenu from "../shared/ContextMenu";
import { useContextMenu, type ContextMenuItem } from "../../hooks/useContextMenu";
import type { FriendshipWithUser, User } from "../../types";

type FriendsSectionProps = {
  onShowUserCard: (user: User, top: number, left: number) => void;
};

function FriendsSection({ onShowUserCard }: FriendsSectionProps) {
  const { t } = useTranslation("common");
  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandedSections = useSidebarStore((s) => s.expandedSections);
  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const removeFriend = useFriendStore((s) => s.removeFriend);
  const dmChannels = useDMStore((s) => s.channels);
  const dmUnreadCounts = useDMStore((s) => s.dmUnreadCounts);
  const openTab = useUIStore((s) => s.openTab);
  const selectDM = useDMStore((s) => s.selectDM);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const initiateCall = useP2PCallStore((s) => s.initiateCall);
  const { menuState, openMenu, closeMenu } = useContextMenu();

  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);
  const isExpanded = expandedSections["friends"] ?? true;

  // Map DM unread counts to the friend's user id so an unread DM also surfaces
  // its badge on the friend's row in this list (not only in the DM section).
  const unreadByUserId = useMemo(() => {
    const map: Record<string, number> = {};
    for (const ch of dmChannels) {
      const count = dmUnreadCounts[ch.id] ?? 0;
      if (count > 0) map[ch.other_user.id] = count;
    }
    return map;
  }, [dmChannels, dmUnreadCounts]);

  function handleFriendsClick() {
    openTab("friends", "friends", t("friends"));
    closeAllDrawers();
  }

  async function handleFriendClick(friend: FriendshipWithUser) {
    const name = friend.display_name ?? friend.username;
    const channelId = await useDMStore.getState().createOrGetChannel(friend.user_id);
    if (channelId) {
      openTab(channelId, "dm", name);
      closeAllDrawers();
    }
  }

  function handleFriendContextMenu(e: React.MouseEvent, friend: FriendshipWithUser) {
    const name = friend.display_name ?? friend.username;
    const items: ContextMenuItem[] = [
      {
        label: t("viewProfile"),
        onClick: () => {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          onShowUserCard(
            {
              id: friend.user_id,
              username: friend.username,
              display_name: friend.display_name ?? null,
              avatar_url: friend.avatar_url ?? null,
              status: (friend.user_status ?? "offline") as User["status"],
              custom_status: friend.user_custom_status ?? null,
              email: null,
              language: "en",
              is_platform_admin: false,
              has_seen_download_prompt: false,
              has_seen_welcome: false,
              dm_privacy: "message_request" as const,
              created_at: friend.created_at ?? new Date().toISOString(),
            },
            rect.top,
            rect.right + 8,
          );
        },
      },
      {
        label: t("voiceCall"),
        onClick: () => initiateCall(friend.user_id, "voice"),
      },
      {
        label: t("videoCall"),
        onClick: () => initiateCall(friend.user_id, "video"),
      },
      {
        label: t("sendMessage"),
        onClick: async () => {
          const channelId = await useDMStore.getState().createOrGetChannel(friend.user_id);
          if (channelId) {
            selectDM(channelId);
            openTab(channelId, "dm", name);
            fetchMessages(channelId);
          }
        },
        separator: true,
      },
      {
        label: t("friendRemove"),
        onClick: () => removeFriend(friend.user_id),
        danger: true,
        separator: true,
      },
    ];
    openMenu(e, items);
  }

  return (
    <>
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("friends")}
        >
          <span className={`ch-tree-chevron${isExpanded ? " expanded" : ""}`}>&#x276F;</span>
          <span>{t("friends")}</span>
          {incoming.length > 0 && (
            <span className="ch-tree-badge">{incoming.length}</span>
          )}
        </button>

        {isExpanded && (
          <div className="ch-tree-section-body ch-tree-section-body--scroll">
            <button className="ch-tree-item" onClick={handleFriendsClick}>
              <IconFriends className="ch-tree-icon" width={15} height={15} />
              <span className="ch-tree-label">{t("friends")}</span>
              {incoming.length > 0 && (
                <span className="ch-tree-badge">{incoming.length}</span>
              )}
            </button>

            {friends
              .filter((f) => f.user_status === "online" || f.user_status === "idle" || f.user_status === "dnd")
              .map((friend) => {
                const unread = unreadByUserId[friend.user_id] ?? 0;
                return (
                <button
                  key={friend.user_id}
                  className={`ch-tree-item${unread > 0 ? " has-unread" : ""}`}
                  onClick={() => { void handleFriendClick(friend); }}
                  onContextMenu={(e) => handleFriendContextMenu(e, friend)}
                >
                  <span className="member-av-wrap">
                    <Avatar
                      name={friend.display_name ?? friend.username}
                      avatarUrl={friend.avatar_url ?? undefined}
                      size={24}
                    />
                    <span className={`member-status ${
                      friend.user_status === "online"
                        ? "status-on"
                        : friend.user_status === "idle"
                          ? "status-idle"
                          : friend.user_status === "dnd"
                            ? "status-dnd"
                            : "status-off"
                    }`} />
                  </span>
                  <span className="ch-tree-label">
                    {friend.display_name ?? friend.username}
                  </span>
                  {unread > 0 && <span className="ch-tree-badge">{unread}</span>}
                </button>
                );
              })}
          </div>
        )}
      </div>

      <ContextMenu state={menuState} onClose={closeMenu} />
    </>
  );
}

export default FriendsSection;
