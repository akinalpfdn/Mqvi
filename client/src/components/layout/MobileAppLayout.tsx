/**
 * MobileAppLayout — Mobile layout orchestrator.
 *
 * Rendered when useIsMobile() is true. Hooks remain in AppLayout;
 * this component only manages mobile layout structure.
 *
 * Structure:
 * - Hamburger + members buttons live inside PanelTabBar (mobile-only) — saves a row
 * - MobileDrawer left (Sidebar) / right (MemberList)
 * - SplitPaneContainer (single panel, no split)
 *
 * Swipe: left-edge → sidebar drawer, right-edge → members drawer.
 */

import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useSwipeGesture } from "../../hooks/useSwipeGesture";
import { getCapacitorPlatform } from "../../utils/constants";
import MobileDrawer from "./MobileDrawer";
import Sidebar from "./Sidebar";
import MemberList from "./MemberList";
import SplitPaneContainer from "./SplitPaneContainer";
type MobileAppLayoutProps = {
  sidebarProps: {
    onJoinVoice: (channelId: string) => void;
    onToggleMute: () => void;
    onToggleDeafen: () => void;
    onToggleScreenShare: () => void;
    onDisconnect: () => void;
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

  // Drawer close is handled explicitly by ChannelTree on manual channel click,
  // NOT by watching selectedChannelId — server switch auto-selects channels
  // and we don't want to close the drawer during server browsing.

  // Edge swipe → open drawers.
  // Android: disabled — system back gesture conflicts with left edge swipe.
  //   Users use hamburger/members buttons instead.
  // iOS: edge swipe works (no system back gesture conflict).
  const isAndroid = getCapacitorPlatform() === "android";
  const swipeHandlers = useSwipeGesture({
    onSwipeRight: isAndroid ? undefined : openLeftDrawer,
    onSwipeLeft: isAndroid ? undefined : openRightDrawer,
    edgeWidth: 30,
    threshold: 30,
    velocityThreshold: 0.15,
  });

  return (
    <div className="mqvi-app mobile" {...swipeHandlers}>
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
