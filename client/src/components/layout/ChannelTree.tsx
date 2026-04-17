/**
 * ChannelTree — Collapsible tree with Friends, DMs, and Server sections.
 * Friends and DM sections are extracted into their own components.
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
import { useActiveMembers } from "../../stores/memberStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { hasPermission, Permissions, resolveChannelPermissions } from "../../utils/permissions";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useMobileStore } from "../../stores/mobileStore";
import Avatar from "../shared/Avatar";
import ContextMenu from "../shared/ContextMenu";
import VoiceUserContextMenu from "../voice/VoiceUserContextMenu";
import MuteDurationPicker from "../servers/MuteDurationPicker";
import MemberCard from "../members/MemberCard";
import InviteFriendsModal from "../servers/InviteFriendsModal";
import AddServerModal from "../servers/AddServerModal";
import CreateChannelModal from "../channels/CreateChannelModal";
import ChannelMuteDurationPicker from "../channels/ChannelMuteDurationPicker";
import ChannelPermissionEditor from "../settings/ChannelPermissionEditor";
import Modal from "../shared/Modal";
import EmojiPicker from "../shared/EmojiPicker";
import FriendsSection from "./FriendsSection";
import DMSection from "./DMSection";
import ServerList from "./ServerList";
import CategoryItem from "./CategoryItem";
import ChannelItem from "./ChannelItem";
import { useContextMenu, type ContextMenuItem } from "../../hooks/useContextMenu";
import { useConfirm } from "../../hooks/useConfirm";
import * as channelApi from "../../api/channels";
import type { Channel, User } from "../../types";

type ChannelTreeProps = {
  onJoinVoice: (channelId: string) => void;
};

function ChannelTree({ onJoinVoice }: ChannelTreeProps) {
  const { t: tVoice } = useTranslation("voice");
  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const expandedSections = useSidebarStore((s) => s.expandedSections);

  function isSectionExpanded(key: string): boolean {
    return expandedSections[key] ?? true;
  }

  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);

  const categories = useChannelStore((s) => s.categories);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const mutedServerIds = useServerStore((s) => s.mutedServerIds);

  const confirmDialog = useConfirm();

  const { menuState: catMenuState, openMenu: openCatMenu, closeMenu: closeCatMenu } = useContextMenu();

  // Channel context menu
  const { menuState: chMenuState, openMenu: openChMenu, closeMenu: closeChMenu } = useContextMenu();
  // User profile card state (shared between sections)
  const [userCardTarget, setUserCardTarget] = useState<{
    user: User;
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
  const screenShareViewers = useVoiceStore((s) => s.screenShareViewers);
  const toggleWatchScreenShare = useVoiceStore((s) => s.toggleWatchScreenShare);
  const unreadCounts = useReadStateStore((s) => s.unreadCounts);

  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();
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

  // Channel permission overrides for ConnectVoice check
  const overridesByChannel = useChannelPermissionStore((s) => s.overridesByChannel);
  const fetchOverridesForChannels = useChannelPermissionStore((s) => s.fetchOverridesForChannels);

  // Fetch overrides for all voice channels when categories change
  useEffect(() => {
    const voiceChannelIds: string[] = [];
    for (const cg of categories) {
      for (const ch of cg.channels) {
        if (ch.type === "voice") voiceChannelIds.push(ch.id);
      }
    }
    if (voiceChannelIds.length > 0) {
      fetchOverridesForChannels(voiceChannelIds);
    }
  }, [categories, fetchOverridesForChannels]);

  /** Check if current user can connect to a voice channel (considering overrides) */
  const canConnectVoice = useCallback(
    (channelId: string): boolean => {
      if (!currentMember) return false;
      const basePerms = currentMember.effective_permissions;
      const roleIds = currentMember.roles.map((r) => r.id);
      const overrides = overridesByChannel[channelId] ?? [];
      const effective = resolveChannelPermissions(basePerms, roleIds, overrides);
      return (effective & Permissions.ConnectVoice) !== 0;
    },
    [currentMember, overridesByChannel]
  );

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

  // ─── Category Drag & Drop State ───

  const reorderCategories = useChannelStore((s) => s.reorderCategories);

  /** Dragged category ID */
  const dragCatReorderIdRef = useRef<string | null>(null);
  /** Category drop indicator position */
  const [catDropIndicator, setCatDropIndicator] = useState<{
    categoryId: string;
    position: "above" | "below";
  } | null>(null);

  function handleCatDragStart(e: React.DragEvent, categoryId: string) {
    e.stopPropagation();
    dragCatReorderIdRef.current = categoryId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/category", categoryId);
  }

  function handleCatDragOver(e: React.DragEvent, categoryId: string) {
    // Only handle if a category is being dragged (not a channel)
    if (!dragCatReorderIdRef.current) return;
    if (dragCatReorderIdRef.current === categoryId) {
      e.preventDefault();
      setCatDropIndicator(null);
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: "above" | "below" = e.clientY < midY ? "above" : "below";
    setCatDropIndicator({ categoryId, position: pos });
  }

  function handleCatDragLeave() {
    setCatDropIndicator(null);
  }

  function handleCatDrop(e: React.DragEvent, targetCategoryId: string) {
    e.preventDefault();
    setCatDropIndicator(null);

    const dragId = dragCatReorderIdRef.current;
    dragCatReorderIdRef.current = null;

    if (!dragId || dragId === targetCategoryId) return;

    // Filter out uncategorized — only named categories are reorderable
    const namedCategories = categories.filter((cg) => cg.category.id !== "");
    const dragIdx = namedCategories.findIndex((cg) => cg.category.id === dragId);
    const targetIdx = namedCategories.findIndex((cg) => cg.category.id === targetCategoryId);
    if (dragIdx === -1 || targetIdx === -1) return;

    const ordered = [...namedCategories];
    const [dragged] = ordered.splice(dragIdx, 1);

    let insertIdx = ordered.findIndex((cg) => cg.category.id === targetCategoryId);
    if (insertIdx === -1) insertIdx = ordered.length;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    const items = ordered.map((cg, idx) => ({ id: cg.category.id, position: idx }));
    reorderCategories(items).then((ok) => {
      if (!ok) addToast("error", tCh("reorderError"));
    });
  }

  function handleCatDragEnd() {
    dragCatReorderIdRef.current = null;
    setCatDropIndicator(null);
  }

  function handleCatRowDragOver(e: React.DragEvent, categoryId: string) {
    if (dragCatReorderIdRef.current) {
      handleCatDragOver(e, categoryId);
    } else {
      handleCategoryHeaderDragOver(e);
    }
  }

  function handleCatRowDrop(e: React.DragEvent, categoryId: string) {
    if (dragCatReorderIdRef.current) {
      handleCatDrop(e, categoryId);
    } else {
      handleCategoryHeaderDrop(e, categoryId);
    }
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
      // Block drop on non-voice, same channel, or channel where mover lacks ConnectVoice
      if (channelType !== "voice" || dragVoiceSourceChannelRef.current === channelId || !canConnectVoice(channelId)) return;
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
    closeAllDrawers();
  }

  function handleVoiceChannelClick(channelId: string, channelName: string) {
    onJoinVoice(channelId);
    openTab(channelId, "voice", channelName, getActiveServerInfo());
    closeAllDrawers();
  }

  // Callback for FriendsSection / DMSection to show user profile card
  const handleShowUserCard = useCallback((user: User, top: number, left: number) => {
    setUserCardTarget({ user, top, left });
  }, []);

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

  return (
    <div className="ch-tree">
      <FriendsSection onShowUserCard={handleShowUserCard} />
      <DMSection onShowUserCard={handleShowUserCard} />

      <ServerList
        onAddServer={() => setShowAddServer(true)}
        onCreateChannel={() => {
          setCreateModalMode(undefined);
          setCreateModalCategoryId(undefined);
          setShowCreateModal(true);
        }}
        onInviteServer={(serverId, serverName) => setInviteTarget({ serverId, serverName })}
        onMuteServer={(serverId, x, y) => setMutePicker({ serverId, x, y })}
        renderServerBody={(srvId) => (
          <>
            {canManageChannels &&
              categories.length > 0 && !categories.some((c) => c.category.id === "") && (
              <div
                className="ch-tree-uncat-drop"
                onDragOver={handleCategoryHeaderDragOver}
                onDrop={(e) => handleCategoryHeaderDrop(e, "")}
              />
            )}

            {categories.map((cg) => {
                    const isUncategorized = cg.category.id === "";
                    const catKey = isUncategorized ? "cat:__uncategorized__" : `cat:${cg.category.id}`;
                    const catExpanded = isUncategorized ? true : isSectionExpanded(catKey);
                    const catId = cg.category.id;
                    const catDropClass =
                      catDropIndicator?.categoryId === catId && catDropIndicator.position === "above" ? " cat-drop-above"
                      : catDropIndicator?.categoryId === catId && catDropIndicator.position === "below" ? " cat-drop-below"
                      : "";

                    return (
                      <CategoryItem
                        key={catId || "__uncategorized__"}
                        category={cg.category}
                        isUncategorized={isUncategorized}
                        expanded={catExpanded}
                        canManageChannels={canManageChannels}
                        onToggle={() => toggleSection(catKey)}
                        onContextMenu={(e) => handleCategoryContextMenu(e, catId, cg.category.name)}
                        onCreateChannel={() => {
                          setCreateModalMode("channel");
                          setCreateModalCategoryId(catId);
                          setShowCreateModal(true);
                        }}
                        catDropClass={catDropClass}
                        onCatDragStart={(e) => handleCatDragStart(e, catId)}
                        onCatRowDragOver={(e) => handleCatRowDragOver(e, catId)}
                        onCatDragLeave={handleCatDragLeave}
                        onCatRowDrop={(e) => handleCatRowDrop(e, catId)}
                        onCatDragEnd={handleCatDragEnd}
                        onUncatDragOver={handleCategoryHeaderDragOver}
                        onUncatDrop={(e) => handleCategoryHeaderDrop(e, "")}
                        isRenaming={renamingCategoryId === catId}
                        renameValue={renameValue}
                        onRenameChange={setRenameValue}
                        onRenameSubmit={() => { setShowRenameEmoji(false); handleCategoryRenameSubmit(); }}
                        onRenameCancel={() => { setShowRenameEmoji(false); setRenamingCategoryId(null); }}
                        showRenameEmoji={showRenameEmoji}
                        renameEmojiBtnRef={renameEmojiBtnRef}
                        onOpenRenameEmoji={openRenameEmojiPicker}
                      >
                        {cg.channels.map((ch) => {
                    const isText = ch.type === "text";
                    const chActive = isText
                      ? ch.id === selectedChannelId
                      : ch.id === currentVoiceChannelId;
                    const unread = unreadCounts[ch.id] ?? 0;
                    const participants = voiceStates[ch.id] ?? [];
                    const isServerMuted = mutedServerIds.has(srvId);
                    const isChannelMuted = mutedChannelIds.has(ch.id);
                    const isEffectivelyMuted = isServerMuted || isChannelMuted;
                    const isVoiceLocked = !isText && !canConnectVoice(ch.id);

                    return (
                      <ChannelItem
                        key={ch.id}
                        channel={ch}
                        isActive={chActive}
                        unread={unread}
                        isEffectivelyMuted={isEffectivelyMuted}
                        isVoiceLocked={isVoiceLocked}
                        voiceDropTarget={voiceDropTargetId === ch.id}
                        canManageChannels={canManageChannels}
                        isDragging={dragChannelIdRef.current === ch.id}
                        dropPos={dropIndicator?.channelId === ch.id ? dropIndicator.position : null}
                        onClick={() => {
                          if (isVoiceLocked) return;
                          isText
                            ? handleTextChannelClick(ch.id, ch.name)
                            : handleVoiceChannelClick(ch.id, ch.name);
                        }}
                        onContextMenu={(e) => handleChannelContextMenu(e, ch)}
                        onDragStart={() => handleDragStart(ch.id, cg.category.id)}
                        onDragOver={(e) => handleChannelDragOver(e, ch.id, ch.type, cg.category.id)}
                        onDragLeave={handleChannelDragLeave}
                        onDrop={(e) => handleChannelDrop(e, ch.id, cg.category.id)}
                        onDragEnd={handleDragEnd}
                        isRenaming={renamingChannelId === ch.id}
                        renameValue={renameValue}
                        onRenameChange={setRenameValue}
                        onRenameSubmit={() => { setShowRenameEmoji(false); handleChannelRenameSubmit(); }}
                        onRenameCancel={() => { setShowRenameEmoji(false); setRenamingChannelId(null); }}
                        showRenameEmoji={showRenameEmoji}
                        renameEmojiBtnRef={renameEmojiBtnRef}
                        onOpenRenameEmoji={openRenameEmojiPicker}
                      >
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
                                  draggable={isMe || canMoveMembers}
                                  onDragStart={(e) => handleVoiceUserDragStart(e, p.user_id, ch.id)}
                                  onDragEnd={handleVoiceUserDragEnd}
                                  title={(isMe || canMoveMembers) ? tVoice("dragToMove") : undefined}
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
                                  <button
                                    className="ch-tree-vu-avatar-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                      setUserCardTarget({
                                        user: {
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
                                        top: rect.top,
                                        left: rect.right + 8,
                                      });
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
                                      <>
                                        <button
                                          className={`ch-tree-vu-icon ch-tree-vu-stream${watchingScreenShares[p.user_id] ? " watching" : ""}`}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            const wasWatching = watchingScreenShares[p.user_id];
                                            toggleWatchScreenShare(p.user_id);
                                            if (!wasWatching && currentVoiceChannelId) {
                                              openTab(currentVoiceChannelId, "voice", ch.name, getActiveServerInfo());
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
                        )}
                      </ChannelItem>
                    );
                  })}
                </CategoryItem>
              );
            })}
          </>
        )}
      />

      {/* Add Server Modal */}
      {showAddServer && (
        <AddServerModal
          onClose={() => setShowAddServer(false)}
        />
      )}

      {/* User Profile Card (shared between FriendsSection / DMSection / voice participants) */}
      {userCardTarget && (
        <MemberCard
          user={userCardTarget.user}
          position={{ top: userCardTarget.top, left: userCardTarget.left }}
          onClose={() => setUserCardTarget(null)}
        />
      )}

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
