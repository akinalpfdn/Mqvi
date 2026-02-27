/**
 * MobileAppLayout — Mobil layout orchestrator.
 *
 * AppLayout'tan useIsMobile() true olduğunda render edilir.
 * Hook'lar (useWebSocket, useVoice, vb.) AppLayout'ta kalır —
 * bu component sadece mobil layout yapısını yönetir.
 *
 * Yapı:
 * - MobileHeader (üst bar: hamburger + kanal adı + members)
 * - MobileDrawer left (Sidebar)
 * - MobileDrawer right (MemberList)
 * - PanelTabBar (scrollable, split yok)
 * - Aktif view (ChatArea / VoiceRoom / DMChat / FriendsView / P2PCallScreen)
 *
 * Swipe gesture'lar:
 * - Sol kenardan sağa: sidebar drawer aç
 * - Sağ kenardan sola: members drawer aç
 */

import { useEffect } from "react";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useChannelStore } from "../../stores/channelStore";
import { useSwipeGesture } from "../../hooks/useSwipeGesture";
import MobileHeader from "./MobileHeader";
import MobileDrawer from "./MobileDrawer";
import Sidebar from "./Sidebar";
import MemberList from "./MemberList";
import SplitPaneContainer from "./SplitPaneContainer";
import type { UserStatus } from "../../types";

type MobileAppLayoutProps = {
  /** Sidebar props — AppLayout'tan iletilir */
  sidebarProps: {
    onJoinVoice: (channelId: string) => void;
    onToggleMute: () => void;
    onToggleDeafen: () => void;
    onToggleScreenShare: () => void;
    onDisconnect: () => void;
    sendPresenceUpdate: (status: UserStatus) => void;
  };
  sendTyping: (channelId: string) => void;
  sendDMTyping: (dmChannelId: string) => void;
};

function MobileAppLayout({ sidebarProps, sendTyping, sendDMTyping }: MobileAppLayoutProps) {
  const layout = useUIStore((s) => s.layout);

  const leftDrawerOpen = useMobileStore((s) => s.leftDrawerOpen);
  const rightDrawerOpen = useMobileStore((s) => s.rightDrawerOpen);
  const openLeftDrawer = useMobileStore((s) => s.openLeftDrawer);
  const closeLeftDrawer = useMobileStore((s) => s.closeLeftDrawer);
  const openRightDrawer = useMobileStore((s) => s.openRightDrawer);
  const closeRightDrawer = useMobileStore((s) => s.closeRightDrawer);
  const closeAllDrawers = useMobileStore((s) => s.closeAllDrawers);

  // Kanal değiştiğinde drawer'ları kapat
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  useEffect(() => {
    closeAllDrawers();
  }, [selectedChannelId, closeAllDrawers]);

  // Swipe gesture — sol/sağ kenardan drawer aç
  const swipeHandlers = useSwipeGesture({
    onSwipeRight: openLeftDrawer,
    onSwipeLeft: openRightDrawer,
    edgeWidth: 20,
    threshold: 40,
    velocityThreshold: 0.2,
  });

  return (
    <div className="mqvi-app mobile" {...swipeHandlers}>
      {/* Mobile Header — hamburger + kanal adı + members toggle */}
      <MobileHeader />

      {/* Sol Drawer — Sidebar */}
      <MobileDrawer
        isOpen={leftDrawerOpen}
        onClose={closeLeftDrawer}
        side="left"
      >
        <Sidebar {...sidebarProps} />
      </MobileDrawer>

      {/* Sağ Drawer — MemberList */}
      <MobileDrawer
        isOpen={rightDrawerOpen}
        onClose={closeRightDrawer}
        side="right"
      >
        <MemberList />
      </MobileDrawer>

      {/* Ana içerik alanı — tek panel (split disabled) */}
      <div className="app-body">
        <div className="main-area">
          <SplitPaneContainer node={layout} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />
        </div>
      </div>
    </div>
  );
}

export default MobileAppLayout;
