/**
 * Settings Store — Zustand ile ayarlar modal'ı + tema state yönetimi.
 *
 * Neden ayrı store?
 * - Slice pattern: her concern ayrı dosyada (authStore, channelStore, settingsStore)
 * - Settings modal'ı birden fazla component'ten açılabilir (sidebar gear, context menu vb.)
 * - activeTab state'i SettingsNav ve SettingsModal arasında paylaşılır
 *
 * Tema yönetimi:
 * - themeId state'i mevcut temayı tutar
 * - setTheme() hem store'u günceller hem applyTheme() ile CSS variable'ları swap eder
 * - localStorage("mqvi_theme") ile persist edilir
 * - Store init'inde kaydedilmiş tema yüklenir (yoksa DEFAULT_THEME)
 */

import { create } from "zustand";
import { type ThemeId, DEFAULT_THEME, applyTheme } from "../styles/themes";

/** localStorage key — tema tercihi burada saklanır */
const THEME_STORAGE_KEY = "mqvi_theme";

/**
 * loadPersistedTheme — localStorage'dan kaydedilmiş tema ID'sini okur.
 * Geçersiz veya boş ise DEFAULT_THEME döner.
 */
function loadPersistedTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (
      stored === "ocean" ||
      stored === "aurora" ||
      stored === "midnight" ||
      stored === "ember" ||
      stored === "deepTeal"
    ) {
      return stored;
    }
  } catch {
    /* SSR veya localStorage erişim hatası — sessizce geç */
  }
  return DEFAULT_THEME;
}

/**
 * Settings modal'daki her sekmenin ID'si.
 * - profile, appearance, voice: User Settings kategorisi
 * - server-general, roles, members, invites: Server Settings kategorisi
 */
type SettingsTab =
  | "profile"
  | "appearance"
  | "voice"
  | "server-general"
  | "channels"
  | "roles"
  | "members"
  | "invites";

type SettingsState = {
  /** Modal açık mı? */
  isOpen: boolean;
  /** Aktif sekme ID'si */
  activeTab: SettingsTab;
  /** Aktif tema ID'si */
  themeId: ThemeId;

  /**
   * openSettings — Modal'ı açar.
   * @param tab - Açılacak sekme (varsayılan: "profile")
   */
  openSettings: (tab?: SettingsTab) => void;

  /** closeSettings — Modal'ı kapatır */
  closeSettings: () => void;

  /** setActiveTab — Aktif sekmeyi değiştirir */
  setActiveTab: (tab: SettingsTab) => void;

  /**
   * setTheme — Temayı değiştirir.
   * 1. CSS variable'ları swap eder (applyTheme)
   * 2. Zustand state günceller
   * 3. localStorage'a persist eder
   */
  setTheme: (id: ThemeId) => void;
};

export type { SettingsTab };

/** Store oluşturulmadan önce persist edilmiş temayı yükle */
const initialTheme = loadPersistedTheme();

export const useSettingsStore = create<SettingsState>((set) => ({
  isOpen: false,
  activeTab: "profile",
  themeId: initialTheme,

  openSettings: (tab = "profile") => set({ isOpen: true, activeTab: tab }),
  closeSettings: () => set({ isOpen: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  setTheme: (id) => {
    applyTheme(id);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      /* localStorage dolu veya erişim yok — sessizce geç */
    }
    set({ themeId: id });
  },
}));

/**
 * Uygulama ilk yüklendiğinde kaydedilmiş temayı CSS'e uygula.
 * Bu satır modül yüklendiğinde (import sırasında) bir kez çalışır.
 * DEFAULT_THEME olan midnight zaten :root fallback ile eşleşir,
 * ama kullanıcı farklı tema seçmişse burada hemen uygulanır.
 */
applyTheme(initialTheme);
