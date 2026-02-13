/**
 * Settings Store — Zustand ile ayarlar modal'ı state yönetimi.
 *
 * Neden ayrı store?
 * - Slice pattern: her concern ayrı dosyada (authStore, channelStore, settingsStore)
 * - Settings modal'ı birden fazla component'ten açılabilir (sidebar gear, context menu vb.)
 * - activeTab state'i SettingsNav ve SettingsModal arasında paylaşılır
 *
 * SettingsTab nedir?
 * Modal'daki her sekmenin benzersiz ID'si. Bu ID ile SettingsModal
 * hangi content component'ini render edeceğini belirler.
 */

import { create } from "zustand";

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
  | "roles"
  | "members"
  | "invites";

type SettingsState = {
  /** Modal açık mı? */
  isOpen: boolean;
  /** Aktif sekme ID'si */
  activeTab: SettingsTab;

  /**
   * openSettings — Modal'ı açar.
   * @param tab - Açılacak sekme (varsayılan: "profile")
   */
  openSettings: (tab?: SettingsTab) => void;

  /** closeSettings — Modal'ı kapatır */
  closeSettings: () => void;

  /** setActiveTab — Aktif sekmeyi değiştirir */
  setActiveTab: (tab: SettingsTab) => void;
};

export type { SettingsTab };

export const useSettingsStore = create<SettingsState>((set) => ({
  isOpen: false,
  activeTab: "profile",

  openSettings: (tab = "profile") => set({ isOpen: true, activeTab: tab }),
  closeSettings: () => set({ isOpen: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
