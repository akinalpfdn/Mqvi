/**
 * Sidebar Store — Left sidebar expand/collapse state.
 *
 * Two modes:
 * - Expanded (240px): Full tree view — Header + ChannelTree + UserBar
 * - Collapsed (52px): Server icon + badges only
 *
 * Section keys: "friends", "dms", "server", "cat:{categoryId}"
 * Missing keys default to expanded (true).
 * State is persisted to localStorage("mqvi_sidebar").
 */

import { create } from "zustand";

const SIDEBAR_STORAGE_KEY = "mqvi_sidebar";

type PersistedSidebar = {
  isExpanded: boolean;
  expandedSections: Record<string, boolean>;
};

function loadPersistedSidebar(): PersistedSidebar {
  try {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSidebar>;
      return {
        isExpanded: typeof parsed.isExpanded === "boolean" ? parsed.isExpanded : true,
        expandedSections:
          parsed.expandedSections && typeof parsed.expandedSections === "object"
            ? parsed.expandedSections
            : { friends: true, dms: true, server: true },
      };
    }
  } catch {
    /* parse error — use defaults */
  }
  return {
    isExpanded: true,
    expandedSections: { friends: true, dms: true, server: true },
  };
}

function persistSidebar(state: PersistedSidebar): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage full or inaccessible */
  }
}

// ──────────────────────────────────
// Store types
// ──────────────────────────────────

type SidebarState = {
  /** true = 240px, false = 52px */
  isExpanded: boolean;
  /** Section expand/collapse states. Missing key = expanded (true). */
  expandedSections: Record<string, boolean>;

  // ─── Actions ───
  toggleSidebar: () => void;
  expandSidebar: () => void;
  collapseSidebar: () => void;
  toggleSection: (sectionKey: string) => void;
  expandSection: (sectionKey: string) => void;
  isSectionExpanded: (sectionKey: string) => boolean;
};

// ──────────────────────────────────
// Store
// ──────────────────────────────────

const initial = loadPersistedSidebar();

export const useSidebarStore = create<SidebarState>((set, get) => ({
  isExpanded: initial.isExpanded,
  expandedSections: initial.expandedSections,

  toggleSidebar: () => {
    set((state) => {
      const next = !state.isExpanded;
      persistSidebar({ isExpanded: next, expandedSections: state.expandedSections });
      return { isExpanded: next };
    });
  },

  expandSidebar: () => {
    set((state) => {
      if (state.isExpanded) return state;
      persistSidebar({ isExpanded: true, expandedSections: state.expandedSections });
      return { isExpanded: true };
    });
  },

  collapseSidebar: () => {
    set((state) => {
      if (!state.isExpanded) return state;
      persistSidebar({ isExpanded: false, expandedSections: state.expandedSections });
      return { isExpanded: false };
    });
  },

  toggleSection: (sectionKey) => {
    set((state) => {
      const current = state.expandedSections[sectionKey] ?? true;
      const next = {
        ...state.expandedSections,
        [sectionKey]: !current,
      };
      persistSidebar({ isExpanded: state.isExpanded, expandedSections: next });
      return { expandedSections: next };
    });
  },

  expandSection: (sectionKey) => {
    set((state) => {
      if (state.expandedSections[sectionKey]) return state;
      const next = {
        ...state.expandedSections,
        [sectionKey]: true,
      };
      persistSidebar({ isExpanded: state.isExpanded, expandedSections: next });
      return { expandedSections: next };
    });
  },

  isSectionExpanded: (sectionKey) => {
    return get().expandedSections[sectionKey] ?? true;
  },
}));
