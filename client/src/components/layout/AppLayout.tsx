/**
 * AppLayout — Main layout with sidebar, split panes, and member list.
 *
 * Desktop:
 * ┌─────────┬──────────────────────┬─────────┐
 * │ Sidebar │ SplitPaneContainer   │ Members │
 * │ (240px) │ (flex-1, recursive)  │ (240px) │
 * └─────────┴──────────────────────┴─────────┘
 *
 * Mobile (<768px): MobileAppLayout with drawer sidebar/members.
 *
 * Single WS hook here — routes all events to stores.
 * Voice orchestration props passed down to Sidebar/UserBar.
 * Cascade refetch on server switch (channels, members, roles, readState).
 */

import { useEffect, useMemo, useRef, useCallback } from "react";
import { useIsMobile } from "../../hooks/useMediaQuery";
import SplitPaneContainer from "./SplitPaneContainer";
import MobileAppLayout from "./MobileAppLayout";
import MemberList from "./MemberList";
import Sidebar from "./Sidebar";
import ToastContainer from "../shared/ToastContainer";
import ConfirmDialog from "../shared/ConfirmDialog";
import DownloadPromptModal from "../shared/DownloadPromptModal";
import WelcomeModal from "../shared/WelcomeModal";
import SettingsModal from "../settings/SettingsModal";
import VoiceProvider from "../voice/VoiceProvider";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useVoice } from "../../hooks/useVoice";
import { useIdleDetection } from "../../hooks/useIdleDetection";
import { useVoiceActivityReporter } from "../../hooks/useVoiceActivityReporter";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useP2PCall } from "../../hooks/useP2PCall";
import { useE2EE } from "../../hooks/useE2EE";
import { useE2EEStore } from "../../stores/e2eeStore";
import RecoveryPasswordPrompt from "../shared/RecoveryPasswordPrompt";
import IncomingCallOverlay from "../p2p/IncomingCallOverlay";
import QuickSwitcher from "../shared/QuickSwitcher";
import ScreenPicker from "../voice/ScreenPicker";
import AFKKickPopup from "../voice/AFKKickPopup";
import ConnectionBanner from "../shared/ConnectionBanner";
import CustomTitleBar from "./CustomTitleBar";
import { isElectron } from "../../utils/constants";
import { useServerStore } from "../../stores/serverStore";
import { useChannelStore } from "../../stores/channelStore";
import { useMemberStore } from "../../stores/memberStore";
import { useRoleStore } from "../../stores/roleStore";
import { useUIStore, type TabServerInfo } from "../../stores/uiStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useMessageStore } from "../../stores/messageStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useInviteStore } from "../../stores/inviteStore";
import { useSoundboardStore } from "../../stores/soundboardStore";
import { useNotificationBadge } from "../../hooks/useNotificationBadge";

function AppLayout() {
  const { sendTyping, sendDMTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate, sendWS, connectionStatus, reconnectAttempt } =
    useWebSocket();

  // Idle detection — auto-set "idle" after 5min inactivity
  useIdleDetection({ sendPresenceUpdate });

  // Voice AFK activity reporter — sends voice_activity ping while in voice
  useVoiceActivityReporter({ sendWS });

  // Electron taskbar badge for unread count
  useNotificationBadge();

  // E2EE device identity check + key init
  useE2EE();
  const showRecoveryPrompt = useE2EEStore((s) => s.showRecoveryPrompt);

  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const fetchActiveServer = useServerStore((s) => s.fetchActiveServer);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const fetchRoles = useRoleStore((s) => s.fetchRoles);
  const fetchUnreadCounts = useReadStateStore((s) => s.fetchUnreadCounts);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const categories = useChannelStore((s) => s.categories);
  const layout = useUIStore((s) => s.layout);
  const openTab = useUIStore((s) => s.openTab);

  // Prevents duplicate auto-tab-open; reset on server switch
  const autoOpenedRef = useRef(false);

  // Clear and refetch all server-scoped stores
  const cascadeRefetch = useCallback(() => {
    const serverId = useServerStore.getState().activeServerId;

    // Clear server-scoped store data (readState is global, no clear needed)
    useChannelStore.getState().clearForServerSwitch();
    useInviteStore.getState().clearForServerSwitch();
    useSoundboardStore.getState().clearForServerSwitch();

    // Reset auto-open flag for new server
    autoOpenedRef.current = false;

    // Fetch new server data
    fetchActiveServer();
    fetchChannels();
    if (serverId) {
      fetchMembers(serverId);
      fetchRoles(serverId);
      fetchUnreadCounts(serverId);
    }
  }, [fetchActiveServer, fetchChannels, fetchMembers, fetchRoles, fetchUnreadCounts]);

  // Cascade refetch on server change (deduplicated via prevServerRef)
  const prevServerRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeServerId && activeServerId !== prevServerRef.current) {
      prevServerRef.current = activeServerId;
      cascadeRefetch();
    }
  }, [activeServerId, cascadeRefetch]);

  // Auto-open the first selected channel as a UI tab after channels load
  useEffect(() => {
    if (!selectedChannelId || autoOpenedRef.current) return;
    if (categories.length === 0) return;

    const channel = categories
      .flatMap((cg) => cg.channels)
      .find((ch) => ch.id === selectedChannelId);

    if (channel) {
      // Attach server info to tab for multi-server context
      let serverInfo: TabServerInfo | undefined;
      if (activeServerId) {
        const srv = servers.find((s) => s.id === activeServerId);
        if (srv) {
          serverInfo = { serverId: srv.id, serverName: srv.name, serverIconUrl: srv.icon_url };
        }
      }
      openTab(
        channel.id,
        channel.type === "text" ? "text" : "voice",
        channel.name,
        serverInfo
      );
      autoOpenedRef.current = true;
    }
  }, [selectedChannelId, categories, openTab, activeServerId, servers]);

  // Auto-mark-read when switching channels
  useEffect(() => {
    if (!selectedChannelId) return;

    const messages = useMessageStore.getState().messagesByChannel[selectedChannelId];
    if (messages && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      useReadStateStore.getState().markAsRead(selectedChannelId, lastMessage.id);
    } else {
      // Messages not loaded yet — still clear local badge
      useReadStateStore.getState().clearUnread(selectedChannelId);
    }
  }, [selectedChannelId]);

  const { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreenShare } = useVoice({
    sendVoiceJoin,
    sendVoiceLeave,
    sendVoiceStateUpdate,
  });

  // Global keyboard shortcuts
  useKeyboardShortcuts({ toggleMute, toggleDeafen });

  // P2P call lifecycle
  useP2PCall();

  // ─── Voice ↔ Tab sync ───

  // Register leaveVoice so uiStore.closeTab can trigger voice disconnect
  useEffect(() => {
    useVoiceStore.getState().registerOnLeave(leaveVoice);
    return () => {
      useVoiceStore.getState().registerOnLeave(null);
    };
  }, [leaveVoice]);

  // Register sendWS for deep components (e.g. VoiceUserContextMenu) to avoid prop drilling
  useEffect(() => {
    useVoiceStore.getState().registerWsSend(sendWS);
    return () => {
      useVoiceStore.getState().registerWsSend(null);
    };
  }, [sendWS]);

  // Voice channel change -> close stale voice tabs + refetch channel list
  // (hidden channels may become visible via voice-connected override, or vice versa)
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const prevVoiceChannelRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prev = prevVoiceChannelRef.current;
    prevVoiceChannelRef.current = currentVoiceChannelId;

    // Skip initial mount — cascadeRefetch handles it
    if (prev === undefined) return;

    // Left voice channel — close related tabs
    if (prev && !currentVoiceChannelId) {
      useUIStore.getState().closeVoiceTabs(prev);
    }

    // Refetch channels on voice channel change
    if (prev !== currentVoiceChannelId) {
      fetchChannels();
    }
  }, [currentVoiceChannelId, fetchChannels]);

  // ─── Responsive layout ───
  const isMobile = useIsMobile();

  // Stable sidebar props shared by desktop and mobile layouts
  const sidebarProps = useMemo(
    () => ({
      onJoinVoice: joinVoice,
      onToggleMute: toggleMute,
      onToggleDeafen: toggleDeafen,
      onToggleScreenShare: toggleScreenShare,
      onDisconnect: leaveVoice,
      sendPresenceUpdate,
    }),
    [joinVoice, toggleMute, toggleDeafen, toggleScreenShare, leaveVoice, sendPresenceUpdate]
  );

  // Shared overlays rendered in both mobile and desktop layouts
  const overlays = (
    <>
      {/* Connection status banner */}
      <ConnectionBanner status={connectionStatus} reconnectAttempt={reconnectAttempt} />

      {/* Settings modal */}
      <SettingsModal />

      {/* Confirm dialog */}
      <ConfirmDialog />

      {/* Toast notifications */}
      <ToastContainer />

      {/* One-time welcome modal for new users */}
      <WelcomeModal />

      {/* One-time download prompt for web users */}
      <DownloadPromptModal />

      {/* Quick Switcher (Ctrl+K) */}
      <QuickSwitcher />

      {/* P2P incoming call overlay */}
      <IncomingCallOverlay />

      {/* Electron screen picker */}
      <ScreenPicker />

      {/* AFK kick popup — manual dismiss only */}
      <AFKKickPopup />

      {/* E2EE recovery password prompt (non-blocking — shown when E2EE is active) */}
      {showRecoveryPrompt && <RecoveryPasswordPrompt />}
    </>
  );

  // Mobile layout
  if (isMobile) {
    const mobileContent = (
      <VoiceProvider>
        <MobileAppLayout
          sidebarProps={sidebarProps}
          sendTyping={sendTyping}
          sendDMTyping={sendDMTyping}
        />
        {overlays}
      </VoiceProvider>
    );

    if (isElectron()) {
      return (
        <div className="electron-app-wrapper">
          <CustomTitleBar />
          {mobileContent}
        </div>
      );
    }

    return mobileContent;
  }

  // Desktop layout
  const desktopContent = (
    <div className="mqvi-app">
      {/* Sidebar */}
      <Sidebar {...sidebarProps} />

      {/* VoiceProvider wraps body — keeps LiveKit connection alive across tab switches */}
      <VoiceProvider>
        <div className="app-body">
          {/* Main content area */}
          <div className="main-area">
            {/* Split pane container */}
            <SplitPaneContainer node={layout} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />

            {/* Member list panel */}
            <MemberList />
          </div>
        </div>
      </VoiceProvider>

      {overlays}
    </div>
  );

  // Electron: custom titlebar (frameless window)
  if (isElectron()) {
    return (
      <div className="electron-app-wrapper">
        <CustomTitleBar />
        {desktopContent}
      </div>
    );
  }

  return desktopContent;
}

export default AppLayout;
