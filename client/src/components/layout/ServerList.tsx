import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useServerStore } from "../../stores/serverStore";
import { useUIStore } from "../../stores/uiStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useJoinRequestStore } from "../../stores/joinRequestStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { resolveAssetUrl } from "../../utils/constants";
import ContextMenu from "../shared/ContextMenu";
import ServerVoicePopup from "./ServerVoicePopup";
import { useContextMenu, type ContextMenuItem } from "../../hooks/useContextMenu";
import { useConfirm } from "../../hooks/useConfirm";

const VOICE_POPUP_HOVER_MS = 300;

type ServerListProps = {
  onAddServer: () => void;
  onCreateChannel: () => void;
  onInviteServer: (serverId: string, serverName: string) => void;
  onMuteServer: (serverId: string, x: number, y: number) => void;
  /** Renders categories + channels for the active expanded server. */
  renderServerBody: (serverId: string) => ReactNode;
};

function ServerList({
  onAddServer,
  onCreateChannel,
  onInviteServer,
  onMuteServer,
  renderServerBody,
}: ServerListProps) {
  const { t: tServers } = useTranslation("servers");
  const { t: tCh } = useTranslation("channels");
  const { t: tE2EE } = useTranslation("e2ee");
  const { t: tSettings } = useTranslation("settings");

  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandSection = useSidebarStore((s) => s.expandSection);
  const expandedSections = useSidebarStore((s) => s.expandedSections);

  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const reorderServers = useServerStore((s) => s.reorderServers);
  const mutedServerIds = useServerStore((s) => s.mutedServerIds);
  const unmuteServer = useServerStore((s) => s.unmuteServer);
  const activeServer = useServerStore((s) => s.activeServer);
  const leaveServer = useServerStore((s) => s.leaveServer);
  const toggleServerE2EE = useServerStore((s) => s.toggleE2EE);

  const markAllAsRead = useReadStateStore((s) => s.markAllAsRead);
  const getServerUnreadTotal = useReadStateStore((s) => s.getServerUnreadTotal);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const openDiscovery = useUIStore((s) => s.openDiscovery);
  const addToast = useToastStore((s) => s.addToast);
  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();

  const confirmDialog = useConfirm();
  const { menuState, openMenu, closeMenu } = useContextMenu();

  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageChannels = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageChannels)
    : false;
  const canManageInvites = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageInvites)
    : false;
  const canApproveMembers = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ApproveMembers)
    : false;

  // Pending join-request count for the active server's badge. Only perm-holders may read the
  // count endpoint (perm-gated server-side); the WS join_request_update event keeps it fresh.
  const pendingJoinCount = useJoinRequestStore((s) => s.pendingCounts[activeServerId ?? ""] ?? 0);
  const fetchJoinRequestCount = useJoinRequestStore((s) => s.fetchCount);

  useEffect(() => {
    if (activeServerId && canApproveMembers) {
      fetchJoinRequestCount(activeServerId);
    }
  }, [activeServerId, canApproveMembers, fetchJoinRequestCount]);

  function isSectionExpanded(key: string): boolean {
    return expandedSections[key] ?? true;
  }

  const dragServerIdRef = useRef<string | null>(null);
  const [serverDropIndicator, setServerDropIndicator] = useState<{
    serverId: string;
    position: "above" | "below";
  } | null>(null);

  // ─── Voice presence hover popup ───
  const [voiceHover, setVoiceHover] = useState<{ serverId: string; top: number; left: number } | null>(null);
  const voiceHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearVoiceHoverTimer() {
    if (voiceHoverTimer.current) {
      clearTimeout(voiceHoverTimer.current);
      voiceHoverTimer.current = null;
    }
  }

  function handleServerMouseEnter(e: React.MouseEvent, serverId: string) {
    if (dragServerIdRef.current) return; // don't pop while dragging
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    clearVoiceHoverTimer();
    voiceHoverTimer.current = setTimeout(() => {
      setVoiceHover({ serverId, top: rect.top, left: rect.right + 8 });
    }, VOICE_POPUP_HOVER_MS);
  }

  function handleServerMouseLeave() {
    clearVoiceHoverTimer();
    setVoiceHover(null);
  }

  useEffect(() => clearVoiceHoverTimer, []);

  function handleServerDragStart(e: React.DragEvent, serverId: string) {
    e.stopPropagation();
    dragServerIdRef.current = serverId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/server", serverId);
  }

  function handleServerDragOver(e: React.DragEvent, serverId: string) {
    if (!dragServerIdRef.current) return;
    if (dragServerIdRef.current === serverId) {
      e.preventDefault();
      setServerDropIndicator(null);
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: "above" | "below" = e.clientY < midY ? "above" : "below";
    setServerDropIndicator({ serverId, position: pos });
  }

  function handleServerDragLeave() {
    setServerDropIndicator(null);
  }

  function handleServerDrop(e: React.DragEvent, targetServerId: string) {
    e.preventDefault();
    setServerDropIndicator(null);

    const dragId = dragServerIdRef.current;
    dragServerIdRef.current = null;

    if (!dragId || dragId === targetServerId) return;

    const ordered = [...servers];
    const dragIdx = ordered.findIndex((s) => s.id === dragId);
    const targetIdx = ordered.findIndex((s) => s.id === targetServerId);
    if (dragIdx === -1 || targetIdx === -1) return;

    const [dragged] = ordered.splice(dragIdx, 1);

    let insertIdx = ordered.findIndex((s) => s.id === targetServerId);
    if (insertIdx === -1) insertIdx = ordered.length;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    const items = ordered.map((s, idx) => ({ id: s.id, position: idx }));
    reorderServers(items).then((ok) => {
      if (!ok) addToast("error", tServers("reorderError"));
    });
  }

  function handleServerDragEnd() {
    dragServerIdRef.current = null;
    setServerDropIndicator(null);
  }

  function handleServerClick(serverId: string) {
    if (serverId === activeServerId) return;
    setActiveServer(serverId);
  }

  function handleServerContextMenu(e: React.MouseEvent, serverId: string, serverName: string) {
    const isMuted = mutedServerIds.has(serverId);
    const isOwner = activeServer?.owner_id === currentUser?.id && activeServer?.id === serverId;
    const canInvite = serverId !== activeServerId || canManageInvites;
    const canAccessSettings = serverId === activeServerId && currentMember
      ? hasPermission(currentMember.effective_permissions, Permissions.Admin)
      : false;

    const items: ContextMenuItem[] = [
      ...(canAccessSettings
        ? [{ label: tServers("serverSettings"), onClick: () => openSettings("server-general") }]
        : []),
      {
        label: tServers("markAllAsRead"),
        onClick: async () => {
          const ok = await markAllAsRead(serverId);
          if (ok) addToast("success", tServers("allMarkedAsRead"));
        },
      },
      ...(canInvite
        ? [{ label: tServers("inviteFriends"), onClick: () => onInviteServer(serverId, serverName) }]
        : []),
      ...(isOwner
        ? [{
            label: activeServer?.e2ee_enabled ? tE2EE("disableE2EE") : tE2EE("enableE2EE"),
            onClick: async () => {
              const newState = !activeServer?.e2ee_enabled;
              const confirmed = await confirmDialog({
                title: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
                message: newState ? tE2EE("enableE2EEConfirmServer") : tE2EE("disableE2EEConfirmServer"),
                confirmLabel: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
                danger: !newState,
              });
              if (!confirmed) return;
              const ok = await toggleServerE2EE(serverId, newState);
              if (ok) {
                addToast("success", newState ? tE2EE("e2eeEnabled") : tE2EE("e2eeDisabled"));
              } else {
                addToast("error", tE2EE("e2eeToggleFailed"));
              }
            },
          }]
        : []),
      isMuted
        ? {
            label: tServers("unmuteServer"),
            onClick: async () => {
              const ok = await unmuteServer(serverId);
              if (ok) addToast("success", tServers("serverUnmuted"));
            },
            separator: true,
          }
        : {
            label: tServers("muteServer"),
            onClick: () => onMuteServer(serverId, e.clientX, e.clientY),
            separator: true,
          },
      {
        label: tServers("leaveServer"),
        danger: true,
        disabled: isOwner,
        onClick: async () => {
          if (isOwner) return;
          if (!confirm(tServers("leaveServerConfirmDesc"))) return;
          const ok = await leaveServer(serverId);
          if (ok) addToast("success", tServers("serverLeft"));
        },
        separator: true,
      },
    ];

    openMenu(e, items);
  }

  function Chevron({ expanded }: { expanded: boolean }) {
    return (
      <span className={`ch-tree-chevron${expanded ? " expanded" : ""}`}>
        &#x276F;
      </span>
    );
  }

  return (
    <>
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("servers")}
        >
          <Chevron expanded={isSectionExpanded("servers")} />
          <span>{tServers("servers")}</span>
        </button>

        {isSectionExpanded("servers") && (
          <div className="ch-tree-section-body">
            <button
              className="ch-tree-item ch-tree-add-server"
              onClick={onAddServer}
            >
              <span className="ch-tree-icon">+</span>
              <span className="ch-tree-label">{tServers("addServer")}</span>
            </button>

            <button
              className="ch-tree-item ch-tree-add-server"
              onClick={openDiscovery}
            >
              <span className="ch-tree-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
                </svg>
              </span>
              <span className="ch-tree-label">{tServers("discover")}</span>
            </button>

            {servers.map((srv) => {
              const srvKey = `srv:${srv.id}`;
              const isActive = srv.id === activeServerId;
              const srvExpanded = isSectionExpanded(srvKey);

              function handleSrvHeaderClick() {
                if (!isActive) {
                  handleServerClick(srv.id);
                  expandSection(srvKey);
                } else {
                  toggleSection(srvKey);
                }
              }

              const srvDropPos = serverDropIndicator?.serverId === srv.id ? serverDropIndicator.position : null;
              const isSrvDragging = dragServerIdRef.current === srv.id;

              return (
                <div
                  key={srv.id}
                  className={`ch-tree-server-group${isSrvDragging ? " srv-dragging" : ""}${srvDropPos === "above" ? " srv-drop-above" : ""}${srvDropPos === "below" ? " srv-drop-below" : ""}`}
                  draggable
                  onDragStart={(e) => handleServerDragStart(e, srv.id)}
                  onDragOver={(e) => handleServerDragOver(e, srv.id)}
                  onDragLeave={handleServerDragLeave}
                  onDrop={(e) => handleServerDrop(e, srv.id)}
                  onDragEnd={handleServerDragEnd}
                >
                  <div className="ch-tree-server-header-row">
                    <button
                      className={`ch-tree-server-header${isActive ? " active" : ""}${mutedServerIds.has(srv.id) ? " muted" : ""}`}
                      onClick={handleSrvHeaderClick}
                      onContextMenu={(e) => handleServerContextMenu(e, srv.id, srv.name)}
                      onMouseEnter={(e) => handleServerMouseEnter(e, srv.id)}
                      onMouseLeave={handleServerMouseLeave}
                    >
                      <Chevron expanded={srvExpanded && isActive} />
                      {srv.icon_url ? (
                        <img
                          src={resolveAssetUrl(srv.icon_url)}
                          alt={srv.name}
                          className="ch-tree-server-icon"
                        />
                      ) : (
                        <span className="ch-tree-server-icon-fallback">
                          {srv.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="ch-tree-server-name">{srv.name}</span>
                      {!mutedServerIds.has(srv.id) && (() => {
                        const total = getServerUnreadTotal(srv.id);
                        return total > 0 ? (
                          <span className="ch-tree-server-badge">{total > 99 ? "99+" : total}</span>
                        ) : null;
                      })()}
                    </button>
                    {isActive && canManageChannels && (
                      <button
                        className="ch-tree-server-add"
                        title={tCh("createChannelOrCategory")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCreateChannel();
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>

                  {isActive && canApproveMembers && pendingJoinCount > 0 && (
                    <button
                      className="ch-tree-join-requests"
                      onClick={() => openSettings("join-requests")}
                      title={tSettings("joinRequests")}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <line x1="19" y1="8" x2="19" y2="14" />
                        <line x1="22" y1="11" x2="16" y2="11" />
                      </svg>
                      <span className="ch-tree-join-requests-label">{tSettings("joinRequests")}</span>
                      <span className="ch-tree-join-requests-badge">
                        {pendingJoinCount > 99 ? "99+" : pendingJoinCount}
                      </span>
                    </button>
                  )}

                  {isActive && srvExpanded && renderServerBody(srv.id)}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ContextMenu state={menuState} onClose={closeMenu} />

      {voiceHover && (
        <ServerVoicePopup
          serverId={voiceHover.serverId}
          anchorTop={voiceHover.top}
          anchorLeft={voiceHover.left}
        />
      )}
    </>
  );
}

export default ServerList;
