/**
 * uiStore — VS Code tarzı tab yönetimi + split pane layout state.
 *
 * Konseptler:
 * - **Tab**: Açık bir kanal/voice/screen sekmesi
 * - **Panel**: Bir veya daha fazla tab barındıran panel
 * - **LayoutNode**: Recursive split tree — leaf (tek panel) veya split (ikiye bölünmüş)
 *
 * VS Code mantığı:
 * 1. Dock'tan kanal tıklandığında aktif panelde tab açılır
 * 2. Tab sürüklenip panelin kenarına bırakılırsa splitPanel() ile ekran ikiye bölünür
 * 3. Son tab kapanırsa panel kaldırılır ve layout yeniden hesaplanır
 * 4. Aynı kanal birden fazla panelde açılamaz (zaten açıksa focus yapılır)
 */

import { create } from "zustand";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

export type TabType = "text" | "voice" | "screen" | "dm";

export type Tab = {
  id: string;
  channelId: string;
  type: TabType;
  label: string;
  serverShort?: string;
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

  // Tab actions
  openTab: (channelId: string, type: TabType, label: string, serverShort?: string) => void;
  closeTab: (panelId: string, tabId: string) => void;
  setActiveTab: (panelId: string, tabId: string) => void;

  // Split actions
  splitPanel: (panelId: string, direction: SplitDirection, tabId: string, position?: "before" | "after") => void;
  moveTab: (fromPanelId: string, toPanelId: string, tabId: string) => void;
  setSplitRatio: (path: number[], ratio: number) => void;

  // Panel focus
  setActivePanel: (panelId: string) => void;

  // Members
  toggleMembers: () => void;
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

/**
 * findTabAcrossPanels — Tüm panellerde belirli bir channelId'yi arar.
 * Aynı kanal birden fazla panelde açılamaz kuralını uygulamak için kullanılır.
 */
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

/**
 * removeLeafFromLayout — Layout ağacından bir leaf node'u kaldırır.
 * Kaldırma sonrası kardeş node yukarı taşınır (parent split gereksiz hale gelir).
 */
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

/**
 * updateRatioAtPath — Layout ağacında belirli bir path'teki split node'un ratio'sunu günceller.
 * path: [0] → ilk split'in sol çocuğu, [1] → sağ çocuğu, vb.
 */
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

  openTab(channelId, type, label, serverShort) {
    const state = get();

    // Aynı kanal zaten açıksa → o tab'a ve panele focus yap
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

    // Aktif panelde yeni tab aç
    const panel = state.panels[state.activePanelId];
    if (!panel) return;

    const newTab: Tab = {
      id: nextTabId(),
      channelId,
      type,
      label,
      serverShort,
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

    const newTabs = panel.tabs.filter((t) => t.id !== tabId);

    // Son tab kapandı → paneli kaldır
    if (newTabs.length === 0) {
      // Eğer tek panel kaldıysa silme, boş bırak
      const panelCount = Object.keys(state.panels).length;
      if (panelCount <= 1) {
        set({
          panels: {
            [panelId]: { ...panel, tabs: [], activeTabId: null },
          },
        });
        return;
      }

      // Paneli layout'tan kaldır
      const newLayout = removeLeafFromLayout(state.layout, panelId);
      const newPanels = { ...state.panels };
      delete newPanels[panelId];

      // Aktif panel silindiyse → ilk kalan panele geç
      const newActivePanelId =
        state.activePanelId === panelId
          ? Object.keys(newPanels)[0]
          : state.activePanelId;

      set({
        panels: newPanels,
        layout: newLayout ?? { type: "leaf", panelId: newActivePanelId },
        activePanelId: newActivePanelId,
      });
      return;
    }

    // Tab kapandı ama başka tab'lar var — aktif tab'ı güncelle
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
  },

  splitPanel(panelId, direction, tabId, position = "after") {
    const state = get();
    const sourcePanel = state.panels[panelId];
    if (!sourcePanel) return;

    const tab = sourcePanel.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Tab'ı kaynak panelden çıkar
    const remainingTabs = sourcePanel.tabs.filter((t) => t.id !== tabId);
    const sourceActiveTabId =
      sourcePanel.activeTabId === tabId
        ? remainingTabs[0]?.id ?? null
        : sourcePanel.activeTabId;

    // Yeni panel oluştur
    const newPanelId = nextPanelId();
    const newPanel: Panel = {
      id: newPanelId,
      tabs: [tab],
      activeTabId: tab.id,
    };

    // Layout'u güncelle — kaynak leaf'i split node ile değiştir
    // position: "before" → yeni panel sola/üste, "after" → sağa/alta
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

    set({
      panels: {
        ...state.panels,
        [panelId]: {
          ...sourcePanel,
          tabs: remainingTabs,
          activeTabId: sourceActiveTabId,
        },
        [newPanelId]: newPanel,
      },
      layout: insertSplit(state.layout),
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

    // Kaynak panelden çıkar
    const fromTabs = fromPanel.tabs.filter((t) => t.id !== tabId);
    const fromActiveTabId =
      fromPanel.activeTabId === tabId
        ? fromTabs[0]?.id ?? null
        : fromPanel.activeTabId;

    const newPanels = { ...state.panels };

    // Kaynak panel boşaldıysa → kaldır
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

    // Normal taşıma
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
}));
