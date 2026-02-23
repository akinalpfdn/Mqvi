/**
 * Sidebar Store — Zustand ile sol sidebar state yönetimi.
 *
 * Sidebar iki modda çalışır:
 * - **Expanded** (240px): Tam ağaç görünümü — Header + ChannelTree + UserBar
 * - **Collapsed** (52px): Yalnızca server ikonu + badge'ler
 *
 * Ağaç yapısı (VS Code tarzı collapsible):
 * ├─ Friends (collapsible section)
 * ├─ DMs (collapsible section)
 * └─ Server (collapsible, altında categories)
 *    ├─ Category 1 (collapsible)
 *    │  ├─ #text-channel
 *    │  └─ 🔊 voice-channel
 *    └─ Category 2
 *       └─ ...
 *
 * Her section'ın expand/collapse durumu `expandedSections` map'inde saklanır.
 * Key format: "friends", "dms", "server", "cat:{categoryId}"
 *
 * State localStorage("mqvi_sidebar") ile persist edilir.
 */

import { create } from "zustand";

const SIDEBAR_STORAGE_KEY = "mqvi_sidebar";

/** localStorage'a persist edilecek state subset'i */
type PersistedSidebar = {
  isExpanded: boolean;
  expandedSections: Record<string, boolean>;
};

/**
 * loadPersistedSidebar — localStorage'dan kaydedilmiş sidebar state'ini okur.
 * Geçersiz veya boş ise varsayılan değerler döner.
 */
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
    /* parse hatası — varsayılan kullan */
  }
  return {
    isExpanded: true,
    expandedSections: { friends: true, dms: true, server: true },
  };
}

/**
 * persistSidebar — Sidebar state'inin ilgili kısmını localStorage'a yazar.
 */
function persistSidebar(state: PersistedSidebar): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage dolu veya erişim yok */
  }
}

// ──────────────────────────────────
// Store types
// ──────────────────────────────────

type SidebarState = {
  /** Sidebar genişletilmiş mi? (true = 240px, false = 52px) */
  isExpanded: boolean;

  /**
   * Section expand/collapse durumları.
   * Key formatları:
   * - "friends" → Friends section
   * - "dms" → DMs section
   * - "server" → Server section (ana düğüm)
   * - "cat:{categoryId}" → Belirli bir kanal kategorisi
   *
   * Map'te bulunmayan key → varsayılan olarak açık (true) kabul edilir.
   */
  expandedSections: Record<string, boolean>;

  // ─── Actions ───

  /** Sidebar expand/collapse toggle */
  toggleSidebar: () => void;
  /** Sidebar'ı genişlet (collapsed'dan gelindiğinde) */
  expandSidebar: () => void;
  /** Sidebar'ı daralt */
  collapseSidebar: () => void;

  /** Belirli bir section'ı toggle et */
  toggleSection: (sectionKey: string) => void;
  /** Belirli bir section'ı aç */
  expandSection: (sectionKey: string) => void;

  /**
   * isSectionExpanded — Bir section açık mı kontrol eder.
   * Map'te yoksa varsayılan true döner (ilk açılışta tüm section'lar açık).
   */
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
