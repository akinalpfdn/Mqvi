/**
 * MobileAppLayout — Mobile layout orchestrator.
 *
 * Rendered when useIsMobile() is true. Hooks remain in AppLayout;
 * this component only manages mobile layout structure.
 *
 * Structure:
 * - MobileHeader (top bar: hamburger + channel name + members)
 * - MobileDrawer left (Sidebar) / right (MemberList)
 * - SplitPaneContainer (single panel, no split)
 *
 * Swipe: left-edge → sidebar drawer, right-edge → members drawer.
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

  // Close drawers on channel change
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  useEffect(() => {
    closeAllDrawers();
  }, [selectedChannelId, closeAllDrawers]);

  // Edge swipe → open drawers
  const swipeHandlers = useSwipeGesture({
    onSwipeRight: openLeftDrawer,
    onSwipeLeft: openRightDrawer,
    edgeWidth: 20,
    threshold: 40,
    velocityThreshold: 0.2,
  });

  return (
    <div className="mqvi-app mobile" {...swipeHandlers}>
      <MobileHeader />

      {/* Left drawer — Sidebar */}
      <MobileDrawer
        isOpen={leftDrawerOpen}
        onClose={closeLeftDrawer}
        side="left"
      >
        <Sidebar {...sidebarProps} />
      </MobileDrawer>

      {/* Right drawer — MemberList */}
      <MobileDrawer
        isOpen={rightDrawerOpen}
        onClose={closeRightDrawer}
        side="right"
      >
        <MemberList />
      </MobileDrawer>

      <div className="app-body">
        <div className="main-area">
          <SplitPaneContainer node={layout} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />
        </div>
      </div>
    </div>
  );
}

export default MobileAppLayout;
