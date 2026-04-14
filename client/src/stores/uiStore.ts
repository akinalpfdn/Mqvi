/**
 * uiStore — VS Code-style tab management + split pane layout state.
 */

import { create } from "zustand";
import { useVoiceStore } from "./voiceStore";
import { useMessageStore } from "./messageStore";
import { useReadStateStore } from "./readStateStore";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

export type TabType = "text" | "voice" | "screen" | "dm" | "friends" | "p2p";

/** Server info for multi-server tab disambiguation. Not needed for DM/friends/p2p. */
export type TabServerInfo = {
  serverId: string;
  serverName: string;
  serverIconUrl: string | null;
};

export type Tab = {
  id: string;
  channelId: string;
  type: TabType;
  label: string;
  /** Required for text/voice tabs, undefined for DM/friends/p2p */
  serverInfo?: TabServerInfo;
  hasUnread?: boolean;
};

export type Panel = {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
};

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "leaf"; panelId: string }
  | {
      type: "split";
      direction: SplitDirection;
      children: [LayoutNode, LayoutNode];
      ratio: number;
    };

// ──────────────────────────────────
// Store interface
// ──────────────────────────────────

type UIState = {
  panels: Record<string, Panel>;
  layout: LayoutNode;
  activePanelId: string;
  membersOpen: boolean;
  quickSwitcherOpen: boolean;

  // Tab actions
  openTab: (channelId: string, type: TabType, label: string, serverInfo?: TabServerInfo) => void;
  closeTab: (panelId: string, tabId: string) => void;
  setActiveTab: (panelId: string, tabId: string) => void;

  // Voice-tab sync
  closeVoiceTabs: (channelId: string) => void;

  // Permission-based tab cleanup (text channels only)
  closeTextTabByChannel: (channelId: string) => void;

  // Close all tabs that belong to a given server (on leave / kick / delete)
  closeTabsForServer: (serverId: string) => void;

  // Split actions
  splitPanel: (panelId: string, direction: SplitDirection, tabId: string, position?: "before" | "after", fromPanelId?: string) => void;
  moveTab: (fromPanelId: string, toPanelId: string, tabId: string) => void;
  setSplitRatio: (path: number[], ratio: number) => void;

  // Panel focus
  setActivePanel: (panelId: string) => void;

  // Members
  toggleMembers: () => void;

  closeDMTab: (channelId: string) => void;

  // Tab label sync (WS channel_update)
  updateTabLabel: (channelId: string, newLabel: string) => void;

  // Quick Switcher (Ctrl+K)
  toggleQuickSwitcher: () => void;
  closeQuickSwitcher: () => void;
};

// ──────────────────────────────────
// Helpers
// ──────────────────────────────────

let panelIdCounter = 0;
function nextPanelId(): string {
  panelIdCounter += 1;
  return `panel-${panelIdCounter}`;
}

let tabIdCounter = 0;
function nextTabId(): string {
  tabIdCounter += 1;
  return `tab-${tabIdCounter}`;
}

/** Find a channel across all panels (enforces single-open rule). */
function findTabAcrossPanels(
  panels: Record<string, Panel>,
  channelId: string
): { panelId: string; tabId: string } | null {
  for (const [panelId, panel] of Object.entries(panels)) {
    const tab = panel.tabs.find((t) => t.channelId === channelId);
    if (tab) return { panelId, tabId: tab.id };
  }
  return null;
}

/** Remove a leaf from layout tree; sibling promotes up when parent split becomes unnecessary. */
function removeLeafFromLayout(
  node: LayoutNode,
  panelId: string
): LayoutNode | null {
  if (node.type === "leaf") {
    return node.panelId === panelId ? null : node;
  }

  const left = removeLeafFromLayout(node.children[0], panelId);
  const right = removeLeafFromLayout(node.children[1], panelId);

  if (left === null && right === null) return null;
  if (left === null) return right;
  if (right === null) return left;

  return { ...node, children: [left, right] };
}

/** Update split ratio at a given tree path. */
function updateRatioAtPath(
  node: LayoutNode,
  path: number[],
  ratio: number
): LayoutNode {
  if (path.length === 0 && node.type === "split") {
    return { ...node, ratio };
  }

  if (node.type === "split" && path.length > 0) {
    const [head, ...rest] = path;
    const newChildren: [LayoutNode, LayoutNode] = [...node.children];
    newChildren[head] = updateRatioAtPath(newChildren[head], rest, ratio);
    return { ...node, children: newChildren };
  }

  return node;
}

/**
 * Trigger voice leave when a voice/screen tab is closed.
 * Called AFTER state update to avoid recursion: tab is already gone
 * when voice leave fires, so closeVoiceTabs becomes a no-op.
 */
function triggerVoiceLeaveIfNeeded(closingTab: Tab | undefined): void {
  if (!closingTab) return;
  if (closingTab.type !== "voice" && closingTab.type !== "screen") return;

  const vs = useVoiceStore.getState();
  if (vs.currentVoiceChannelId === closingTab.channelId && vs._onLeaveCallback) {
    vs._onLeaveCallback();
  }
}

// ──────────────────────────────────
// Default state
// ──────────────────────────────────

const defaultPanelId = nextPanelId();

const defaultPanel: Panel = {
  id: defaultPanelId,
  tabs: [],
  activeTabId: null,
};

// ──────────────────────────────────
// Store
// ──────────────────────────────────

export const useUIStore = create<UIState>((set, get) => ({
  panels: { [defaultPanelId]: defaultPanel },
  layout: { type: "leaf", panelId: defaultPanelId },
  activePanelId: defaultPanelId,
  membersOpen: true,
  quickSwitcherOpen: false,

  openTab(channelId, type, label, serverInfo) {
    const state = get();

    // Channel already open — focus it
    const existing = findTabAcrossPanels(state.panels, channelId);
    if (existing) {
      set({
        activePanelId: existing.panelId,
        panels: {
          ...state.panels,
          [existing.panelId]: {
            ...state.panels[existing.panelId],
            activeTabId: existing.tabId,
          },
        },
      });
      return;
    }

    // Open new tab in active panel
    const panel = state.panels[state.activePanelId];
    if (!panel) return;

    const newTab: Tab = {
      id: nextTabId(),
      channelId,
      type,
      label,
      serverInfo,
    };

    set({
      panels: {
        ...state.panels,
        [panel.id]: {
          ...panel,
          tabs: [...panel.tabs, newTab],
          activeTabId: newTab.id,
        },
      },
    });
  },

  closeTab(panelId, tabId) {
    const state = get();
    const panel = state.panels[panelId];
    if (!panel) return;

    // Save closing tab info for voice/screen sync
    const closingTab = panel.tabs.find((t) => t.id === tabId);

    const newTabs = panel.tabs.filter((t) => t.id !== tabId);

    // Last tab closed — remove panel
    if (newTabs.length === 0) {
      // Keep the last panel alive (empty)
      const panelCount = Object.keys(state.panels).length;
      if (panelCount <= 1) {
        set({
          panels: {
            [panelId]: { ...panel, tabs: [], activeTabId: null },
          },
        });
        // Voice leave after state update
        triggerVoiceLeaveIfNeeded(closingTab);
        return;
      }

      // Remove panel from layout
      const newLayout = removeLeafFromLayout(state.layout, panelId);
      const newPanels = { ...state.panels };
      delete newPanels[panelId];

      // Switch to first remaining panel if active was removed
      const newActivePanelId =
        state.activePanelId === panelId
          ? Object.keys(newPanels)[0]
          : state.activePanelId;

      set({
        panels: newPanels,
        layout: newLayout ?? { type: "leaf", panelId: newActivePanelId },
        activePanelId: newActivePanelId,
      });
      // Trigger voice leave after state update
      triggerVoiceLeaveIfNeeded(closingTab);
      return;
    }

    // Other tabs remain — update active tab
    const newActiveTabId =
      panel.activeTabId === tabId
        ? newTabs[Math.max(0, newTabs.findIndex((t) => t.id === tabId) - 1)]?.id ?? newTabs[0]?.id ?? null
        : panel.activeTabId;

    set({
      panels: {
        ...state.panels,
        [panelId]: {
          ...panel,
          tabs: newTabs,
          activeTabId: newActiveTabId,
        },
      },
    });
    // Voice leave after state update
    triggerVoiceLeaveIfNeeded(closingTab);
  },

  closeVoiceTabs(channelId) {
    // Close voice/screen tabs after voice leave. No recursion risk:
    // currentVoiceChannelId is already null, so triggerVoiceLeaveIfNeeded is a no-op.
    const state = get();

    // Find all voice/screen tabs across panels
    const tabsToClose: { panelId: string; tabId: string }[] = [];
    for (const [pId, panel] of Object.entries(state.panels)) {
      for (const tab of panel.tabs) {
        if (
          (tab.type === "voice" || tab.type === "screen") &&
          tab.channelId === channelId
        ) {
          tabsToClose.push({ panelId: pId, tabId: tab.id });
        }
      }
    }

    // Close each (state updates per call)
    for (const { panelId: pId, tabId: tId } of tabsToClose) {
      get().closeTab(pId, tId);
    }
  },

  setActiveTab(panelId, tabId) {
    const state = get();
    const panel = state.panels[panelId];
    if (!panel) return;

    set({
      activePanelId: panelId,
      panels: {
        ...state.panels,
        [panelId]: { ...panel, activeTabId: tabId },
      },
    });

    // Mark-as-read when switching to a text tab — sidebar-selection isn't the
    // only path into a channel; tab-switching needs to clear the unread badge too.
    const tab = panel.tabs.find((t) => t.id === tabId);
    if (tab && tab.type === "text") {
      const messages = useMessageStore.getState().messagesByChannel[tab.channelId];
      if (messages && messages.length > 0) {
        useReadStateStore.getState().markAsRead(tab.channelId, messages[messages.length - 1].id);
      } else {
        useReadStateStore.getState().clearUnread(tab.channelId);
      }
    }
  },

  splitPanel(panelId, direction, tabId, position = "after", fromPanelId?) {
    const state = get();
    const targetPanel = state.panels[panelId];
    if (!targetPanel) return;

    // Tab can come from target panel (same-panel split) or another panel (cross-panel)
    const actualFromId = fromPanelId ?? panelId;
    const fromPanel = state.panels[actualFromId];
    if (!fromPanel) return;

    const tab = fromPanel.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Remove tab from source panel
    const remainingTabs = fromPanel.tabs.filter((t) => t.id !== tabId);
    const fromActiveTabId =
      fromPanel.activeTabId === tabId
        ? remainingTabs[0]?.id ?? null
        : fromPanel.activeTabId;

    // Create new panel for the dragged tab
    const newPanelId = nextPanelId();
    const newPanel: Panel = {
      id: newPanelId,
      tabs: [tab],
      activeTabId: tab.id,
    };

    // Replace target leaf with split node
    function insertSplit(node: LayoutNode): LayoutNode {
      if (node.type === "leaf" && node.panelId === panelId) {
        const first: LayoutNode = position === "before"
          ? { type: "leaf", panelId: newPanelId }
          : { type: "leaf", panelId };
        const second: LayoutNode = position === "before"
          ? { type: "leaf", panelId }
          : { type: "leaf", panelId: newPanelId };
        return {
          type: "split",
          direction,
          children: [first, second],
          ratio: 0.5,
        };
      }
      if (node.type === "split") {
        return {
          ...node,
          children: [
            insertSplit(node.children[0]),
            insertSplit(node.children[1]),
          ],
        };
      }
      return node;
    }

    const newPanels = { ...state.panels };
    let newLayout = insertSplit(state.layout);

    // Source panel: remove tab (or remove entire panel if empty)
    if (remainingTabs.length === 0 && actualFromId !== panelId) {
      // Source panel becomes empty — remove it from layout
      delete newPanels[actualFromId];
      newLayout = removeLeafFromLayout(newLayout, actualFromId) ?? newLayout;
    } else {
      newPanels[actualFromId] = {
        ...fromPanel,
        tabs: remainingTabs,
        activeTabId: fromActiveTabId,
      };
    }

    newPanels[newPanelId] = newPanel;

    set({
      panels: newPanels,
      layout: newLayout,
      activePanelId: newPanelId,
    });
  },

  moveTab(fromPanelId, toPanelId, tabId) {
    const state = get();
    const fromPanel = state.panels[fromPanelId];
    const toPanel = state.panels[toPanelId];
    if (!fromPanel || !toPanel) return;

    const tab = fromPanel.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Remove from source panel
    const fromTabs = fromPanel.tabs.filter((t) => t.id !== tabId);
    const fromActiveTabId =
      fromPanel.activeTabId === tabId
        ? fromTabs[0]?.id ?? null
        : fromPanel.activeTabId;

    const newPanels = { ...state.panels };

    // Source panel empty — remove it
    if (fromTabs.length === 0 && Object.keys(newPanels).length > 1) {
      const newLayout = removeLeafFromLayout(state.layout, fromPanelId);
      delete newPanels[fromPanelId];
      newPanels[toPanelId] = {
        ...toPanel,
        tabs: [...toPanel.tabs, tab],
        activeTabId: tab.id,
      };

      set({
        panels: newPanels,
        layout: newLayout ?? { type: "leaf", panelId: toPanelId },
        activePanelId: toPanelId,
      });
      return;
    }

    // Normal move
    newPanels[fromPanelId] = {
      ...fromPanel,
      tabs: fromTabs,
      activeTabId: fromActiveTabId,
    };
    newPanels[toPanelId] = {
      ...toPanel,
      tabs: [...toPanel.tabs, tab],
      activeTabId: tab.id,
    };

    set({
      panels: newPanels,
      activePanelId: toPanelId,
    });
  },

  setSplitRatio(path, ratio) {
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    set((state) => ({
      layout: updateRatioAtPath(state.layout, path, clamped),
    }));
  },

  setActivePanel(panelId) {
    set({ activePanelId: panelId });
  },

  toggleMembers() {
    set((state) => ({ membersOpen: !state.membersOpen }));
  },

  updateTabLabel(channelId, newLabel) {
    const state = get();
    let changed = false;
    const newPanels = { ...state.panels };

    for (const [panelId, panel] of Object.entries(newPanels)) {
      const idx = panel.tabs.findIndex((t) => t.channelId === channelId);
      if (idx !== -1 && panel.tabs[idx].label !== newLabel) {
        const newTabs = [...panel.tabs];
        newTabs[idx] = { ...newTabs[idx], label: newLabel };
        newPanels[panelId] = { ...panel, tabs: newTabs };
        changed = true;
      }
    }

    if (changed) set({ panels: newPanels });
  },

  toggleQuickSwitcher() {
    set((state) => ({ quickSwitcherOpen: !state.quickSwitcherOpen }));
  },

  closeQuickSwitcher() {
    set({ quickSwitcherOpen: false });
  },

  closeTextTabByChannel(channelId) {
    const state = get();
    const found = findTabAcrossPanels(state.panels, channelId);
    if (!found) return;

    const panel = state.panels[found.panelId];
    const tab = panel.tabs.find((t) => t.id === found.tabId);
    // Only close text tabs — voice tabs stay open (user may still be in voice)
    if (!tab || tab.type !== "text") return;

    get().closeTab(found.panelId, found.tabId);
  },

  closeDMTab(channelId: string) {
    const state = get();
    const found = findTabAcrossPanels(state.panels, channelId);
    if (!found) return;

    const panel = state.panels[found.panelId];
    const tab = panel.tabs.find((t) => t.id === found.tabId);
    if (!tab || tab.type !== "dm") return;

    get().closeTab(found.panelId, found.tabId);
  },

  closeTabsForServer(serverId: string) {
    // Collect every tab scoped to this server first, then close them one-by-one.
    // closeTab mutates the panel state, so we cannot iterate and close inline.
    const state = get();
    const tabsToClose: { panelId: string; tabId: string }[] = [];
    for (const [pId, panel] of Object.entries(state.panels)) {
      for (const tab of panel.tabs) {
        if (tab.serverInfo?.serverId === serverId) {
          tabsToClose.push({ panelId: pId, tabId: tab.id });
        }
      }
    }
    for (const { panelId, tabId } of tabsToClose) {
      get().closeTab(panelId, tabId);
    }
  },
}));
