/**
 * ChannelTree — Collapsible tree with Friends, DMs, and Server sections.
 * Server section shows categories with text/voice channels and inline voice participants.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useUIStore, type TabServerInfo } from "../../stores/uiStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useDMStore } from "../../stores/dmStore";
import { useFriendStore } from "../../stores/friendStore";
import { useBlockStore } from "../../stores/blockStore";
import { useMemberStore } from "../../stores/memberStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { resolveAssetUrl, copyToClipboard } from "../../utils/constants";
import Avatar from "../shared/Avatar";
import ContextMenu from "../shared/ContextMenu";
import VoiceUserContextMenu from "../voice/VoiceUserContextMenu";
import MuteDurationPicker from "../servers/MuteDurationPicker";
import DMMuteDurationPicker from "../dm/DMMuteDurationPicker";
import DMProfileCard from "../dm/DMProfileCard";
import ReportModal from "../shared/ReportModal";
import InviteFriendsModal from "../servers/InviteFriendsModal";
import AddServerModal from "../servers/AddServerModal";
import CreateChannelModal from "../channels/CreateChannelModal";
import ChannelMuteDurationPicker from "../channels/ChannelMuteDurationPicker";
import ChannelPermissionEditor from "../settings/ChannelPermissionEditor";
import Modal from "../shared/Modal";
import EmojiPicker from "../shared/EmojiPicker";
import { useContextMenu, type ContextMenuItem } from "../../hooks/useContextMenu";
import { useConfirm } from "../../hooks/useConfirm";
import { useSettingsStore } from "../../stores/settingsStore";
import * as channelApi from "../../api/channels";
import type { DMChannelWithUser, Channel } from "../../types";

type ChannelTreeProps = {
  onJoinVoice: (channelId: string) => void;
};

function ChannelTree({ onJoinVoice }: ChannelTreeProps) {
  const { t } = useTranslation("common");
  const { t: tVoice } = useTranslation("voice");
  const { t: tServers } = useTranslation("servers");
  const { t: tDM } = useTranslation("dm");
  const { t: tE2EE } = useTranslation("e2ee");

  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandSection = useSidebarStore((s) => s.expandSection);
  // Subscribe to the map (not a function) so toggleSection triggers re-render
  const expandedSections = useSidebarStore((s) => s.expandedSections);

  /** Returns true if section is expanded (default: true) */
  function isSectionExpanded(key: string): boolean {
    return expandedSections[key] ?? true;
  }

  const categories = useChannelStore((s) => s.categories);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
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
  const openSettings = useSettingsStore((s) => s.openSettings);

  const confirmDialog = useConfirm();

  // Server context menu
  const { menuState: serverMenuState, openMenu: openServerMenu, closeMenu: closeServerMenu } = useContextMenu();

  // DM context menu
  const { menuState: dmMenuState, openMenu: openDMMenu, closeMenu: closeDMMenu } = useContextMenu();

  // Category context menu
  const { menuState: catMenuState, openMenu: openCatMenu, closeMenu: closeCatMenu } = useContextMenu();

  // Channel context menu
  const { menuState: chMenuState, openMenu: openChMenu, closeMenu: closeChMenu } = useContextMenu();

  // DM mute duration picker state
  const [dmMutePicker, setDmMutePicker] = useState<{
    channelId: string;
    x: number;
    y: number;
  } | null>(null);

  // DM report modal state
  const [dmReportTarget, setDmReportTarget] = useState<{
    userId: string;
    username: string;
  } | null>(null);

  // DM profile card state
  const [dmProfileTarget, setDmProfileTarget] = useState<{
    dm: DMChannelWithUser;
    top: number;
    left: number;
  } | null>(null);

  // Mute duration picker state
  const [mutePicker, setMutePicker] = useState<{
    serverId: string;
    x: number;
    y: number;
  } | null>(null);

  // Invite Friends modal state
  const [inviteTarget, setInviteTarget] = useState<{
    serverId: string;
    serverName: string;
  } | null>(null);

  // Channel mute duration picker state
  const [channelMutePicker, setChannelMutePicker] = useState<{
    channelId: string;
    x: number;
    y: number;
  } | null>(null);

  // Inline rename state
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);
  const [renamingChannelId, setRenamingChannelId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showRenameEmoji, setShowRenameEmoji] = useState(false);
  const renameEmojiBtnRef = useRef<HTMLButtonElement>(null);
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ top: number; left: number } | null>(null);

  // Recalculate portal picker position when opened
  const openRenameEmojiPicker = useCallback(() => {
    setShowRenameEmoji((prev) => {
      const next = !prev;
      if (next && renameEmojiBtnRef.current) {
        const rect = renameEmojiBtnRef.current.getBoundingClientRect();
        setEmojiPickerPos({ top: rect.top, left: rect.right + 6 });
      }
      return next;
    });
  }, []);

  // Close portal picker on scroll (sidebar scroll changes position)
  useEffect(() => {
    if (!showRenameEmoji) return;
    function handleScroll() { setShowRenameEmoji(false); }
    const tree = document.querySelector(".ch-tree");
    tree?.addEventListener("scroll", handleScroll);
    return () => tree?.removeEventListener("scroll", handleScroll);
  }, [showRenameEmoji]);

  // Channel permission modal state
  const [permModalChannel, setPermModalChannel] = useState<Channel | null>(null);

  // Add Server modal state
  const [showAddServer, setShowAddServer] = useState(false);

  const openTab = useUIStore((s) => s.openTab);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const localMutedUsers = useVoiceStore((s) => s.localMutedUsers);
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const toggleWatchScreenShare = useVoiceStore((s) => s.toggleWatchScreenShare);
  const unreadCounts = useReadStateStore((s) => s.unreadCounts);

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

  const currentUser = useAuthStore((s) => s.user);
  const members = useMemberStore((s) => s.members);
  const addToast = useToastStore((s) => s.addToast);
  const mutedChannelIds = useChannelStore((s) => s.mutedChannelIds);
  const unmuteChannel = useChannelStore((s) => s.unmuteChannel);
  const { t: tCh } = useTranslation("channels");

  // MANAGE_CHANNELS permission
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageChannels = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageChannels)
    : false;

  // MOVE_MEMBERS permission (voice user drag & drop)
  const canMoveMembers = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.MoveMembers)
    : false;

  // MANAGE_INVITES permission
  const canManageInvites = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageInvites)
    : false;

  // WS send for voice user drag & drop
  const wsSend = useVoiceStore((s) => s._wsSend);

  // ─── Voice User Context Menu State ───
  const [voiceCtxMenu, setVoiceCtxMenu] = useState<{
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    x: number;
    y: number;
  } | null>(null);

  // ─── Create Channel/Category Modal State ───
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createModalMode, setCreateModalMode] = useState<"category" | "channel" | undefined>(undefined);
  const [createModalCategoryId, setCreateModalCategoryId] = useState<string | undefined>(undefined);

  // ─── Channel Drag & Drop State ───

  const reorderChannels = useChannelStore((s) => s.reorderChannels);

  /** Dragged channel ID */
  const dragChannelIdRef = useRef<string | null>(null);
  /** Source category ID of dragged channel */
  const dragCategoryIdRef = useRef<string | null>(null);
  /** Drop indicator position */
  const [dropIndicator, setDropIndicator] = useState<{
    channelId: string;
    position: "above" | "below";
  } | null>(null);

  // ─── Voice User Drag & Drop State ───

  /** Dragged voice user ID */
  const dragVoiceUserIdRef = useRef<string | null>(null);
  /** Source channel ID of dragged voice user */
  const dragVoiceSourceChannelRef = useRef<string | null>(null);
  /** Dragging user ID (state for CSS class — ref doesn't trigger render) */
  const [draggingVoiceUserId, setDraggingVoiceUserId] = useState<string | null>(null);
  /** Hovered voice channel drop target ID */
  const [voiceDropTargetId, setVoiceDropTargetId] = useState<string | null>(null);

  // ─── Server Drag & Drop State ───

  /** Dragged server ID */
  const dragServerIdRef = useRef<string | null>(null);
  /** Server drop indicator position */
  const [serverDropIndicator, setServerDropIndicator] = useState<{
    serverId: string;
    position: "above" | "below";
  } | null>(null);

  function handleServerDragStart(e: React.DragEvent, serverId: string) {
    e.stopPropagation();
    dragServerIdRef.current = serverId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/server", serverId);
  }

  function handleServerDragOver(e: React.DragEvent, serverId: string) {
    if (!dragServerIdRef.current) return;
    // Ignore self-drop
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

    // Recalculate target index after splice
    let insertIdx = ordered.findIndex((s) => s.id === targetServerId);
    if (insertIdx === -1) insertIdx = ordered.length;

    // Insert above or below based on mouse position
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    // Assign sequential positions
    const items = ordered.map((s, idx) => ({ id: s.id, position: idx }));
    reorderServers(items).then((ok) => {
      if (!ok) addToast("error", tServers("reorderError"));
    });
  }

  function handleServerDragEnd() {
    dragServerIdRef.current = null;
    setServerDropIndicator(null);
  }

  function handleDragStart(channelId: string, categoryId: string) {
    dragChannelIdRef.current = channelId;
    dragCategoryIdRef.current = categoryId;
  }

  function handleDragOver(e: React.DragEvent, channelId: string, _categoryId: string) {
    // Ignore self-drag
    if (dragChannelIdRef.current === channelId) {
      e.preventDefault();
      setDropIndicator(null);
      return;
    }

    e.preventDefault();

    // Determine above/below based on mouse position
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: "above" | "below" = e.clientY < midY ? "above" : "below";

    setDropIndicator({ channelId, position: pos });
  }

  function handleDragLeave() {
    setDropIndicator(null);
  }

  /** Channel dragged onto a category header — move channel to that category. */
  function handleCategoryHeaderDragOver(e: React.DragEvent) {
    if (!dragChannelIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  /** Drop channel onto category header — append to end of that category. */
  function handleCategoryHeaderDrop(e: React.DragEvent, targetCategoryId: string) {
    e.preventDefault();
    setDropIndicator(null);

    const dragId = dragChannelIdRef.current;
    const dragCatId = dragCategoryIdRef.current;
    dragChannelIdRef.current = null;
    dragCategoryIdRef.current = null;

    if (!dragId) return;
    // Same category — no-op
    if (dragCatId === targetCategoryId) return;

    // Find source category and channel
    const sourceCat = categories.find((c) => c.category.id === dragCatId);
    if (!sourceCat) return;

    const draggedChannel = sourceCat.channels.find((ch) => ch.id === dragId);
    if (!draggedChannel) return;

    // Target category (may not exist for uncategorized id="")
    const targetCat = categories.find((c) => c.category.id === targetCategoryId);

    // Build reorder items: source minus dragged + dragged appended to target
    const items: { id: string; position: number; category_id?: string }[] = [];

    const sourceRemaining = sourceCat.channels.filter((ch) => ch.id !== dragId);
    sourceRemaining.forEach((ch, idx) => {
      items.push({ id: ch.id, position: idx });
    });

    const targetChannels = targetCat?.channels ?? [];
    targetChannels.forEach((ch, idx) => {
      items.push({ id: ch.id, position: idx });
    });
    items.push({
      id: dragId,
      position: targetChannels.length,
      category_id: targetCategoryId,
    });

    reorderChannels(items).then((ok) => {
      if (!ok) addToast("error", tCh("reorderError"));
    });
  }

  function handleDrop(e: React.DragEvent, targetChannelId: string, categoryId: string) {
    e.preventDefault();
    setDropIndicator(null);

    const dragId = dragChannelIdRef.current;
    const dragCatId = dragCategoryIdRef.current;
    dragChannelIdRef.current = null;
    dragCategoryIdRef.current = null;

    if (!dragId || dragId === targetChannelId) return;

    const isCrossCategory = dragCatId !== categoryId;

    if (isCrossCategory) {
      // Cross-category drag-and-drop
      const sourceCat = categories.find((c) => c.category.id === dragCatId);
      const targetCat = categories.find((c) => c.category.id === categoryId);
      if (!sourceCat || !targetCat) return;

      const draggedChannel = sourceCat.channels.find((ch) => ch.id === dragId);
      if (!draggedChannel) return;

      // Calculate insertion point in target category
      const targetOrdered = [...targetCat.channels];
      let insertIdx = targetOrdered.findIndex((ch) => ch.id === targetChannelId);
      if (insertIdx === -1) insertIdx = targetOrdered.length;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY >= midY) insertIdx += 1;

      // Insert dragged channel at target position
      targetOrdered.splice(insertIdx, 0, draggedChannel);

      // Build reorder items for both source and target categories
      const items: { id: string; position: number; category_id?: string }[] = [];

      const sourceRemaining = sourceCat.channels.filter((ch) => ch.id !== dragId);
      sourceRemaining.forEach((ch, idx) => {
        items.push({ id: ch.id, position: idx });
      });

      targetOrdered.forEach((ch, idx) => {
        if (ch.id === dragId) {
          // Moved channel — update category_id
          items.push({ id: ch.id, position: idx, category_id: categoryId });
        } else {
          items.push({ id: ch.id, position: idx });
        }
      });

      reorderChannels(items).then((ok) => {
        if (!ok) addToast("error", tCh("reorderError"));
      });
    } else {
      // Same-category reorder
      const cat = categories.find((c) => c.category.id === categoryId);
      if (!cat) return;

      const ordered = [...cat.channels];
      const dragIdx = ordered.findIndex((ch) => ch.id === dragId);
      const targetIdx = ordered.findIndex((ch) => ch.id === targetChannelId);
      if (dragIdx === -1 || targetIdx === -1) return;

      const [dragged] = ordered.splice(dragIdx, 1);

      let insertIdx = ordered.findIndex((ch) => ch.id === targetChannelId);
      if (insertIdx === -1) insertIdx = ordered.length;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY >= midY) insertIdx += 1;

      ordered.splice(insertIdx, 0, dragged);

      const items = ordered.map((ch, idx) => ({ id: ch.id, position: idx }));
      reorderChannels(items).then((ok) => {
        if (!ok) addToast("error", tCh("reorderError"));
      });
    }
  }

  function handleDragEnd() {
    dragChannelIdRef.current = null;
    dragCategoryIdRef.current = null;
    setDropIndicator(null);
  }

  // ─── Voice User Drag Handlers ───

  // stopPropagation prevents conflict with channel reorder drag
  function handleVoiceUserDragStart(e: React.DragEvent, userId: string, channelId: string) {
    e.stopPropagation();
    dragVoiceUserIdRef.current = userId;
    dragVoiceSourceChannelRef.current = channelId;
    setDraggingVoiceUserId(userId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/voice-user", userId);
  }

  /** Clear all voice drag state on drop or cancel. */
  function handleVoiceUserDragEnd() {
    dragVoiceUserIdRef.current = null;
    dragVoiceSourceChannelRef.current = null;
    setDraggingVoiceUserId(null);
    setVoiceDropTargetId(null);
  }

  /** Unified DragOver — handles both channel reorder and voice user move on the same element. */
  function handleChannelDragOver(
    e: React.DragEvent,
    channelId: string,
    channelType: string,
    categoryId: string
  ) {
    if (dragVoiceUserIdRef.current) {
      if (channelType !== "voice" || dragVoiceSourceChannelRef.current === channelId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setVoiceDropTargetId(channelId);
      return;
    }
    handleDragOver(e, channelId, categoryId);
  }

  // Filter out false leave events when cursor moves between child elements
  function handleChannelDragLeave(e: React.DragEvent) {
    if (dragVoiceUserIdRef.current) {
      const related = e.relatedTarget as Node | null;
      if (related && e.currentTarget.contains(related)) return;
      setVoiceDropTargetId(null);
      return;
    }
    handleDragLeave();
  }

  /** Unified Drop — voice user move (via WS) or channel reorder. */
  function handleChannelDrop(e: React.DragEvent, targetChannelId: string, categoryId: string) {
    if (dragVoiceUserIdRef.current) {
      e.preventDefault();
      const targetUserId = dragVoiceUserIdRef.current;
      dragVoiceUserIdRef.current = null;
      dragVoiceSourceChannelRef.current = null;
      setDraggingVoiceUserId(null);
      setVoiceDropTargetId(null);
      wsSend?.("voice_move_user", {
        target_user_id: targetUserId,
        target_channel_id: targetChannelId,
      });
      return;
    }
    handleDrop(e, targetChannelId, categoryId);
  }

  // ─── Handlers ───

  /** Active server info for tab display */
  function getActiveServerInfo(): TabServerInfo | undefined {
    if (!activeServerId) return undefined;
    const srv = servers.find((s) => s.id === activeServerId);
    if (!srv) return undefined;
    return { serverId: srv.id, serverName: srv.name, serverIconUrl: srv.icon_url };
  }

  function handleTextChannelClick(channelId: string, channelName: string) {
    selectChannel(channelId);
    openTab(channelId, "text", channelName, getActiveServerInfo());
  }

  function handleVoiceChannelClick(channelId: string, channelName: string) {
    onJoinVoice(channelId);
    openTab(channelId, "voice", channelName, getActiveServerInfo());
  }

  function handleDMClick(dmId: string, userName: string) {
    selectDM(dmId);
    openTab(dmId, "dm", userName);
    clearDMUnread(dmId);
    fetchMessages(dmId);
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
          setDmProfileTarget({ dm, top: rect.top, left: rect.right + 8 });
        },
      },
      {
        label: tDM("voiceCall"),
        onClick: () => {
          initiateCall(user.id, "voice");
        },
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
          if (dm.is_pinned) {
            unpinDM(dm.id);
          } else {
            pinDM(dm.id);
          }
        },
      },
      {
        label: dm.is_muted ? tDM("unmuteDM") : tDM("muteDM"),
        onClick: () => {
          if (dm.is_muted) {
            unmuteDM(dm.id);
          } else {
            setDmMutePicker({ channelId: dm.id, x: e.clientX, y: e.clientY });
          }
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
      onClick: () => setDmReportTarget({ userId: user.id, username: name }),
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

    openDMMenu(e, items);
  }

  function handleFriendsClick() {
    openTab("friends", "friends", t("friends"));
  }

  function handleServerClick(serverId: string) {
    if (serverId === activeServerId) return;
    setActiveServer(serverId);
  }

  function handleServerContextMenu(e: React.MouseEvent, serverId: string, serverName: string) {
    const isMuted = mutedServerIds.has(serverId);
    // activeServer (full Server object) only available for the active server
    const isOwner = activeServer?.owner_id === currentUser?.id && activeServer?.id === serverId;

    // ManageInvites only checkable for active server; show for others, backend enforces
    const canInvite = serverId !== activeServerId || canManageInvites;

    // Admin permission only checkable for active server
    const canAccessSettings = serverId === activeServerId && currentMember
      ? hasPermission(currentMember.effective_permissions, Permissions.Admin)
      : false;

    const items: ContextMenuItem[] = [
      ...(canAccessSettings
        ? [
            {
              label: tServers("serverSettings"),
              onClick: () => {
                openSettings("server-general");
              },
            },
          ]
        : []),
      {
        label: tServers("markAllAsRead"),
        onClick: async () => {
          const ok = await markAllAsRead(serverId);
          if (ok) addToast("success", tServers("allMarkedAsRead"));
        },
      },
      ...(canInvite
        ? [
            {
              label: tServers("inviteFriends"),
              onClick: () => {
                setInviteTarget({ serverId, serverName });
              },
            },
          ]
        : []),
      ...(isOwner
        ? [
            {
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
            },
          ]
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
            onClick: () => {
              setMutePicker({ serverId, x: e.clientX, y: e.clientY });
            },
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

    openServerMenu(e, items);
  }

  // ─── Category Context Menu ───

  function handleCategoryContextMenu(e: React.MouseEvent, categoryId: string, categoryName: string) {
    if (!canManageChannels) return;

    const items: ContextMenuItem[] = [
      {
        label: tCh("renameCategory"),
        onClick: () => {
          setShowRenameEmoji(false);
          setRenamingChannelId(null);
          setRenamingCategoryId(categoryId);
          setRenameValue(categoryName);
        },
      },
      {
        label: tCh("deleteCategory"),
        danger: true,
        separator: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: tCh("deleteCategory"),
            message: tCh("deleteCategoryConfirm", { name: categoryName }),
            confirmLabel: tCh("deleteCategory"),
            danger: true,
          });
          if (!ok) return;
          const res = await channelApi.deleteCategory(activeServerId!, categoryId);
          if (res.success) {
            addToast("success", tCh("categoryDeleted"));
          } else {
            addToast("error", tCh("categoryDeleteError"));
          }
        },
      },
    ];

    openCatMenu(e, items);
  }

  // ─── Channel Context Menu ───

  function handleChannelContextMenu(e: React.MouseEvent, ch: Channel) {
    const items: ContextMenuItem[] = [];

    if (canManageChannels) {
      items.push({
        label: tCh("renameChannel"),
        onClick: () => {
          setShowRenameEmoji(false);
          setRenamingCategoryId(null);
          setRenamingChannelId(ch.id);
          setRenameValue(ch.name);
        },
      });
      items.push({
        label: tCh("channelPermissions"),
        onClick: () => setPermModalChannel(ch),
      });
      items.push({
        label: tCh("deleteChannel"),
        danger: true,
        separator: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: tCh("deleteChannel"),
            message: tCh("deleteConfirm", { name: ch.name }),
            confirmLabel: tCh("deleteChannel"),
            danger: true,
          });
          if (!ok) return;
          const res = await channelApi.deleteChannel(activeServerId!, ch.id);
          if (res.success) {
            addToast("success", tCh("channelDeleted"));
          } else {
            addToast("error", tCh("channelDeleteError"));
          }
        },
      });
    }

    // Mute/unmute — text channels only
    if (ch.type === "text") {
      const isMuted = mutedChannelIds.has(ch.id);
      items.push({
        label: isMuted ? tCh("unmuteChannel") : tCh("muteChannel"),
        separator: items.length > 0,
        onClick: async () => {
          if (isMuted) {
            const ok = await unmuteChannel(ch.id);
            if (ok) addToast("success", tCh("channelUnmuted"));
          } else {
            setChannelMutePicker({ channelId: ch.id, x: e.clientX, y: e.clientY });
          }
        },
      });
    }

    if (items.length === 0) return;
    openChMenu(e, items);
  }

  // ─── Inline Rename Handlers ───

  async function handleCategoryRenameSubmit() {
    const id = renamingCategoryId;
    const name = renameValue.trim();
    setRenamingCategoryId(null);

    if (!id || !name || !activeServerId) return;

    const res = await channelApi.updateCategory(activeServerId, id, { name });
    if (res.success) {
      addToast("success", tCh("categoryUpdated"));
    } else {
      addToast("error", tCh("categoryUpdateError"));
    }
  }

  async function handleChannelRenameSubmit() {
    const id = renamingChannelId;
    const name = renameValue.trim();
    setRenamingChannelId(null);

    if (!id || !name || !activeServerId) return;

    const res = await channelApi.updateChannel(activeServerId, id, { name });
    if (res.success) {
      addToast("success", tCh("channelUpdated"));
    } else {
      addToast("error", tCh("channelUpdateError"));
    }
  }

  // ─── Render helpers ───

  function Chevron({ expanded }: { expanded: boolean }) {
    return (
      <span className={`ch-tree-chevron${expanded ? " expanded" : ""}`}>
        &#x276F;
      </span>
    );
  }

  return (
    <div className="ch-tree">
      {/* ═══ Friends Section ═══ */}
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("friends")}
        >
          <Chevron expanded={isSectionExpanded("friends")} />
          <span>{t("friends")}</span>
          {incoming.length > 0 && (
            <span className="ch-tree-badge">{incoming.length}</span>
          )}
        </button>

        {isSectionExpanded("friends") && (
          <div className="ch-tree-section-body">
            <button
              className="ch-tree-item"
              onClick={handleFriendsClick}
            >
              <span className="ch-tree-icon">&#128101;</span>
              <span className="ch-tree-label">{t("friends")}</span>
              {incoming.length > 0 && (
                <span className="ch-tree-badge">{incoming.length}</span>
              )}
            </button>

            {/* Online friends */}
            {friends
              .filter((f) => f.user_status === "online" || f.user_status === "idle" || f.user_status === "dnd")
              .slice(0, 10)
              .map((friend) => (
                <button
                  key={friend.user_id}
                  className="ch-tree-item"
                  onClick={() => handleFriendsClick()}
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

      {/* ═══ DMs Section ═══ */}
      <div className="ch-tree-section">
        <button
          className="ch-tree-section-header"
          onClick={() => toggleSection("dms")}
        >
          <Chevron expanded={isSectionExpanded("dms")} />
          <span>{t("directMessages")}</span>
        </button>

        {isSectionExpanded("dms") && (
          <div className="ch-tree-section-body">
            {dmChannels.length === 0 ? (
              <div className="ch-tree-placeholder">
                <span className="ch-tree-placeholder-text">—</span>
              </div>
            ) : (
              dmChannels.map((dm) => {
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

      {/* ═══ Servers Section ═══ */}
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
            {servers.map((srv) => {
              const srvKey = `srv:${srv.id}`;
              const isActive = srv.id === activeServerId;
              const srvExpanded = isSectionExpanded(srvKey);

              // If not active: activate + expand (not toggle — avoids collapsing on first click)
              // If active: toggle expand/collapse
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
                  {/* Server header — icon + name + unread badge + create button */}
                  <div className="ch-tree-server-header-row">
                    <button
                      className={`ch-tree-server-header${isActive ? " active" : ""}${mutedServerIds.has(srv.id) ? " muted" : ""}`}
                      onClick={handleSrvHeaderClick}
                      onContextMenu={(e) => handleServerContextMenu(e, srv.id, srv.name)}
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
                      {/* Server-level unread badge (excludes muted channels) */}
                      {isActive && !mutedServerIds.has(srv.id) && (() => {
                        const total = Object.entries(unreadCounts).reduce(
                          (sum, [chId, c]) => mutedChannelIds.has(chId) ? sum : sum + c,
                          0,
                        );
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
                          setCreateModalMode(undefined);
                          setCreateModalCategoryId(undefined);
                          setShowCreateModal(true);
                        }}
                      >
                        +
                      </button>
                    )}
                  </div>

                  {/* Uncategorized drop zone */}
                  {isActive && srvExpanded && canManageChannels &&
                    categories.length > 0 && !categories.some((c) => c.category.id === "") && (
                    <div
                      className="ch-tree-uncat-drop"
                      onDragOver={handleCategoryHeaderDragOver}
                      onDrop={(e) => handleCategoryHeaderDrop(e, "")}
                    />
                  )}

                  {/* Categories + channels (active server only) */}
                  {isActive && srvExpanded && categories.map((cg) => {
                    const isUncategorized = cg.category.id === "";
                    const catKey = isUncategorized ? "cat:__uncategorized__" : `cat:${cg.category.id}`;
                    const catExpanded = isUncategorized ? true : isSectionExpanded(catKey);

                    return (
                      <div key={cg.category.id || "__uncategorized__"} className="ch-tree-category">
                        {/* Category header / uncategorized drop zone */}
                        {isUncategorized ? (
                          canManageChannels && (
                            <div
                              className="ch-tree-uncat-drop"
                              onDragOver={handleCategoryHeaderDragOver}
                              onDrop={(e) => handleCategoryHeaderDrop(e, "")}
                            />
                          )
                        ) : (
                          <div
                            className="ch-tree-cat-row"
                            onDragOver={canManageChannels ? handleCategoryHeaderDragOver : undefined}
                            onDrop={canManageChannels ? (e) => handleCategoryHeaderDrop(e, cg.category.id) : undefined}
                          >
                            <button
                              className="ch-tree-cat-header"
                              onClick={() => toggleSection(catKey)}
                              onContextMenu={(e) => handleCategoryContextMenu(e, cg.category.id, cg.category.name)}
                            >
                              <Chevron expanded={catExpanded} />
                              {renamingCategoryId === cg.category.id ? (
                                <div className="ch-tree-rename-wrap" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    className="ch-tree-inline-rename"
                                    value={renameValue}
                                    autoFocus
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    maxLength={50}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === "Enter") { setShowRenameEmoji(false); handleCategoryRenameSubmit(); }
                                      if (e.key === "Escape") { setShowRenameEmoji(false); setRenamingCategoryId(null); }
                                    }}
                                    onBlur={(e) => {
                                      // Don't submit on blur when emoji picker is open
                                      if (e.relatedTarget && (e.relatedTarget as HTMLElement).closest(".ch-tree-rename-picker")) return;
                                      if (!showRenameEmoji) handleCategoryRenameSubmit();
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="ch-tree-rename-emoji"
                                    ref={renameEmojiBtnRef}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={openRenameEmojiPicker}
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <circle cx="12" cy="12" r="10" />
                                      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                                      <line x1="9" y1="9" x2="9.01" y2="9" />
                                      <line x1="15" y1="9" x2="15.01" y2="9" />
                                    </svg>
                                  </button>
                                </div>
                              ) : (
                                <span>{cg.category.name}</span>
                              )}
                            </button>
                            {canManageChannels && (
                              <button
                                className="ch-tree-cat-add"
                                title={tCh("createChannel")}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCreateModalMode("channel");
                                  setCreateModalCategoryId(cg.category.id);
                                  setShowCreateModal(true);
                                }}
                              >
                                +
                              </button>
                            )}
                          </div>
                        )}

                        {catExpanded && cg.channels.map((ch) => {
                    const isText = ch.type === "text";
                    const isActive = isText
                      ? ch.id === selectedChannelId
                      : ch.id === currentVoiceChannelId;
                    const unread = unreadCounts[ch.id] ?? 0;
                    const participants = voiceStates[ch.id] ?? [];
                    const isDragging = dragChannelIdRef.current === ch.id;
                    const dropPos = dropIndicator?.channelId === ch.id ? dropIndicator.position : null;

                    // Muted channels appear dimmed
                    const isServerMuted = mutedServerIds.has(srv.id);
                    const isChannelMuted = mutedChannelIds.has(ch.id);
                    const isEffectivelyMuted = isServerMuted || isChannelMuted;
                    const mutedClass = isEffectivelyMuted ? " muted" : "";

                    return (
                      <div
                        key={ch.id}
                        className={`ch-tree-drag-wrap${isDragging ? " dragging" : ""}${dropPos === "above" ? " drop-above" : ""}${dropPos === "below" ? " drop-below" : ""}`}
                        draggable={canManageChannels}
                        onDragStart={() => handleDragStart(ch.id, cg.category.id)}
                        onDragOver={(e) => handleChannelDragOver(e, ch.id, ch.type, cg.category.id)}
                        onDragLeave={handleChannelDragLeave}
                        onDrop={(e) => handleChannelDrop(e, ch.id, cg.category.id)}
                        onDragEnd={handleDragEnd}
                      >
                        <button
                          className={`ch-tree-item${isActive ? " active" : ""}${!isText ? " voice" : ""}${unread > 0 && !isEffectivelyMuted ? " has-unread" : ""}${voiceDropTargetId === ch.id ? " voice-drop-target" : ""}${mutedClass}`}
                          onClick={() =>
                            isText
                              ? handleTextChannelClick(ch.id, ch.name)
                              : handleVoiceChannelClick(ch.id, ch.name)
                          }
                          onContextMenu={(e) => handleChannelContextMenu(e, ch)}
                          title={
                            isText
                              ? `#${ch.name}`
                              : `${ch.name} — ${tVoice("joinVoice")}`
                          }
                        >
                          <span className="ch-tree-icon">
                            {isText ? "#" : "\uD83D\uDD0A"}
                          </span>
                          {renamingChannelId === ch.id ? (
                            <div className="ch-tree-rename-wrap" onClick={(e) => e.stopPropagation()}>
                              <input
                                className="ch-tree-inline-rename"
                                value={renameValue}
                                autoFocus
                                onChange={(e) => setRenameValue(e.target.value)}
                                maxLength={50}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === "Enter") { setShowRenameEmoji(false); handleChannelRenameSubmit(); }
                                  if (e.key === "Escape") { setShowRenameEmoji(false); setRenamingChannelId(null); }
                                }}
                                onBlur={(e) => {
                                  if (e.relatedTarget && (e.relatedTarget as HTMLElement).closest(".ch-tree-rename-picker")) return;
                                  if (!showRenameEmoji) handleChannelRenameSubmit();
                                }}
                              />
                              <button
                                type="button"
                                className="ch-tree-rename-emoji"
                                ref={renameEmojiBtnRef}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={openRenameEmojiPicker}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="10" />
                                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                                  <line x1="9" y1="9" x2="9.01" y2="9" />
                                  <line x1="15" y1="9" x2="15.01" y2="9" />
                                </svg>
                              </button>
                            </div>
                          ) : (
                            <span className="ch-tree-label">{ch.name}</span>
                          )}
                          {unread > 0 && !isEffectivelyMuted && (
                            <span className="ch-tree-unread-dot" title={`${unread}`} />
                          )}
                        </button>

                        {/* Voice channel participants */}
                        {!isText && participants.length > 0 && (
                          <div className="ch-tree-voice-users">
                            {participants.map((p) => {
                              const isMe = p.user_id === currentUser?.id;
                              const isLocalMuted = localMutedUsers[p.user_id] ?? false;
                              const isSpeaking = activeSpeakers[p.user_id] ?? false;

                              return (
                                <div
                                  key={p.user_id}
                                  className={`ch-tree-voice-user${isSpeaking ? " speaking" : ""}${draggingVoiceUserId === p.user_id ? " vu-dragging" : ""}`}
                                  draggable={canMoveMembers && !isMe}
                                  onDragStart={(e) => handleVoiceUserDragStart(e, p.user_id, ch.id)}
                                  onDragEnd={handleVoiceUserDragEnd}
                                  title={canMoveMembers && !isMe ? tVoice("dragToMove") : undefined}
                                  onContextMenu={(e) => {
                                    if (isMe) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setVoiceCtxMenu({
                                      userId: p.user_id,
                                      username: p.username,
                                      displayName: p.display_name,
                                      avatarUrl: p.avatar_url,
                                      x: e.clientX,
                                      y: e.clientY,
                                    });
                                  }}
                                >
                                  <Avatar
                                    name={p.display_name || p.username}
                                    avatarUrl={p.avatar_url}
                                    size={22}
                                    isCircle
                                  />
                                  <span className="ch-tree-vu-name">{p.display_name || p.username}</span>
                                  {/* Status icons (priority: server deafen > server mute > local mute > streaming > self deafen > self mute > dot) */}
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
                                      <button
                                        className={`ch-tree-vu-icon ch-tree-vu-stream${watchingScreenShares[p.user_id] ? " watching" : ""}`}
                                        onClick={(e) => { e.stopPropagation(); toggleWatchScreenShare(p.user_id); }}
                                        title={watchingScreenShares[p.user_id] ? tVoice("stopWatching") : tVoice("watchScreenShare")}
                                      >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                        </svg>
                                      </button>
                                    )}
                                    {p.is_deafened ? (
                                      <svg className="ch-tree-vu-icon ch-tree-vu-deafen" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                                      </svg>
                                    ) : p.is_muted ? (
                                      <svg className="ch-tree-vu-icon ch-tree-vu-mute" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                                      </svg>
                                    ) : (
                                      <span className="ch-tree-vu-dot" />
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
                </div>
              );
            })}

            {/* Add Server button */}
            <button
              className="ch-tree-item ch-tree-add-server"
              onClick={() => setShowAddServer(true)}
            >
              <span className="ch-tree-icon">+</span>
              <span className="ch-tree-label">{tServers("addServer")}</span>
            </button>
          </div>
        )}
      </div>

      {/* Add Server Modal */}
      {showAddServer && (
        <AddServerModal
          onClose={() => setShowAddServer(false)}
        />
      )}

      {/* DM Context Menu */}
      <ContextMenu state={dmMenuState} onClose={closeDMMenu} />

      {/* DM Mute Duration Picker */}
      {dmMutePicker && (
        <DMMuteDurationPicker
          channelId={dmMutePicker.channelId}
          x={dmMutePicker.x}
          y={dmMutePicker.y}
          onClose={() => setDmMutePicker(null)}
        />
      )}

      {/* DM Report Modal */}
      {dmReportTarget && (
        <ReportModal
          userId={dmReportTarget.userId}
          username={dmReportTarget.username}
          onClose={() => setDmReportTarget(null)}
        />
      )}

      {/* DM Profile Card */}
      {dmProfileTarget && (
        <DMProfileCard
          dm={dmProfileTarget.dm}
          position={{ top: dmProfileTarget.top, left: dmProfileTarget.left }}
          onClose={() => setDmProfileTarget(null)}
        />
      )}

      {/* Server Context Menu */}
      <ContextMenu state={serverMenuState} onClose={closeServerMenu} />

      {/* Mute Duration Picker */}
      {mutePicker && (
        <MuteDurationPicker
          serverId={mutePicker.serverId}
          x={mutePicker.x}
          y={mutePicker.y}
          onClose={() => setMutePicker(null)}
        />
      )}

      {/* Invite Friends Modal */}
      {inviteTarget && (
        <InviteFriendsModal
          serverId={inviteTarget.serverId}
          serverName={inviteTarget.serverName}
          onClose={() => setInviteTarget(null)}
        />
      )}

      {/* Voice User Context Menu */}
      {voiceCtxMenu && (
        <VoiceUserContextMenu
          userId={voiceCtxMenu.userId}
          username={voiceCtxMenu.username}
          displayName={voiceCtxMenu.displayName}
          avatarUrl={voiceCtxMenu.avatarUrl}
          position={{ x: voiceCtxMenu.x, y: voiceCtxMenu.y }}
          onClose={() => setVoiceCtxMenu(null)}
        />
      )}

      {/* Create Channel/Category Modal */}
      {showCreateModal && (
        <CreateChannelModal
          onClose={() => setShowCreateModal(false)}
          defaultMode={createModalMode}
          defaultCategoryId={createModalCategoryId}
        />
      )}

      {/* Category Context Menu */}
      <ContextMenu state={catMenuState} onClose={closeCatMenu} />

      {/* Channel Context Menu */}
      <ContextMenu state={chMenuState} onClose={closeChMenu} />

      {/* Channel Mute Duration Picker */}
      {channelMutePicker && (
        <ChannelMuteDurationPicker
          channelId={channelMutePicker.channelId}
          x={channelMutePicker.x}
          y={channelMutePicker.y}
          onClose={() => setChannelMutePicker(null)}
        />
      )}

      {/* Channel Permission Modal */}
      {permModalChannel && (
        <Modal
          isOpen
          onClose={() => setPermModalChannel(null)}
          title={tCh("channelPermissions")}
        >
          <ChannelPermissionEditor channel={permModalChannel} />
        </Modal>
      )}

      {/* Emoji picker — portaled to body to escape sidebar overflow:hidden */}
      {showRenameEmoji && emojiPickerPos && createPortal(
        <div
          className="ch-tree-rename-picker-portal"
          style={{ position: "fixed", top: emojiPickerPos.top, left: emojiPickerPos.left, zIndex: 9999 }}
        >
          <EmojiPicker
            onSelect={(emoji) => {
              setRenameValue((prev) => {
                const next = prev + emoji;
                return [...next].length <= 50 ? next : prev;
              });
              setShowRenameEmoji(false);
            }}
            onClose={() => setShowRenameEmoji(false)}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

export default ChannelTree;
