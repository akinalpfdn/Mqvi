/**
 * FriendsSection — Collapsible friends list in the sidebar channel tree.
 * Shows online friends (capped at 10) with context menu for profile, calls, DM.
 */

import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useFriendStore } from "../../stores/friendStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import Avatar from "../shared/Avatar";
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
  const openTab = useUIStore((s) => s.openTab);
  const selectDM = useDMStore((s) => s.selectDM);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const initiateCall = useP2PCallStore((s) => s.initiateCall);
  const { menuState, openMenu, closeMenu } = useContextMenu();

  const isExpanded = expandedSections["friends"] ?? true;

  function handleFriendsClick() {
    openTab("friends", "friends", t("friends"));
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
            clearDMUnread(channelId);
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
          <div className="ch-tree-section-body">
            <button className="ch-tree-item" onClick={handleFriendsClick}>
              <span className="ch-tree-icon">&#128101;</span>
              <span className="ch-tree-label">{t("friends")}</span>
              {incoming.length > 0 && (
                <span className="ch-tree-badge">{incoming.length}</span>
              )}
            </button>

            {friends
              .filter((f) => f.user_status === "online" || f.user_status === "idle" || f.user_status === "dnd")
              .slice(0, 10)
              .map((friend) => (
                <button
                  key={friend.user_id}
                  className="ch-tree-item"
                  onClick={() => handleFriendsClick()}
                  onContextMenu={(e) => handleFriendContextMenu(e, friend)}
                >
                  <Avatar
                    name={friend.display_name ?? friend.username}
                    avatarUrl={friend.avatar_url ?? undefined}
                    size={24}
                  />
                  <span className="ch-tree-label">
                    {friend.display_name ?? friend.username}
                  </span>
                  <span
                    className="ch-tree-vu-dot"
                    style={{
                      background:
                        friend.user_status === "online"
                          ? "var(--green)"
                          : friend.user_status === "idle"
                            ? "var(--yellow, #f0b232)"
                            : "var(--red)",
                    }}
                  />
                </button>
              ))}
          </div>
        )}
      </div>

      <ContextMenu state={menuState} onClose={closeMenu} />
    </>
  );
}

export default FriendsSection;
