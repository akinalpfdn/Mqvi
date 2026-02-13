/**
 * Auth Store — Zustand ile kullanıcı oturum yönetimi.
 *
 * Zustand nedir?
 * React için minimalist bir state management kütüphanesidir.
 * Redux'a göre çok daha az boilerplate gerektirir.
 *
 * Nasıl çalışır?
 * 1. create() ile store tanımlanır (state + actions)
 * 2. Component'ler useAuthStore() hook'u ile state'e erişir
 * 3. State değişince, onu kullanan component'ler otomatik yeniden render olur
 *
 * Slice pattern: Her concern (auth, channels, messages) ayrı store dosyasında.
 * Tek monolith store YASAK.
 */

import { create } from "zustand";
import * as authApi from "../api/auth";
import { setTokens, clearTokens } from "../api/client";
import type { User } from "../types";

/** Store'un state + action tipleri */
type AuthState = {
  /** Mevcut kullanıcı (null = giriş yapılmamış) */
  user: User | null;
  /** Yüklenme durumu */
  isLoading: boolean;
  /** Hata mesajı */
  error: string | null;
  /** Auth kontrolü yapıldı mı? (splash screen için) */
  isInitialized: boolean;

  // ─── Actions ───
  register: (username: string, password: string, displayName?: string) => Promise<boolean>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  initialize: () => Promise<void>;
  clearError: () => void;

  /**
   * updateUser — User state'ini kısmen günceller.
   *
   * Profil düzenlemesi (display_name, avatar_url, language vb.)
   * sonrasında tüm kullanıcı bilgisini sunucudan tekrar çekmek yerine
   * sadece değişen field'ları günceller. Performans + anında UI yansıması.
   */
  updateUser: (partial: Partial<User>) => void;
};

/**
 * useAuthStore — Auth state'ini yöneten Zustand store.
 *
 * Kullanım (component içinde):
 *   const { user, login, logout } = useAuthStore();
 *   const isLoggedIn = useAuthStore((s) => s.user !== null);
 *
 * set() fonksiyonu state'i günceller ve ilgili component'leri yeniden render eder.
 * Partial update yapabilir: set({ isLoading: true }) — diğer field'lar değişmez.
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: false,
  error: null,
  isInitialized: false,

  register: async (username, password, displayName) => {
    set({ isLoading: true, error: null });

    const res = await authApi.register({
      username,
      password,
      display_name: displayName,
    });

    if (res.success && res.data) {
      setTokens(res.data.access_token, res.data.refresh_token);
      set({ user: res.data.user, isLoading: false });
      return true;
    }

    set({ error: res.error ?? "Registration failed", isLoading: false });
    return false;
  },

  login: async (username, password) => {
    set({ isLoading: true, error: null });

    const res = await authApi.login({ username, password });

    if (res.success && res.data) {
      setTokens(res.data.access_token, res.data.refresh_token);
      set({ user: res.data.user, isLoading: false });
      return true;
    }

    set({ error: res.error ?? "Login failed", isLoading: false });
    return false;
  },

  logout: async () => {
    const refreshToken = localStorage.getItem("refresh_token");
    if (refreshToken) {
      await authApi.logout(refreshToken);
    }
    clearTokens();
    set({ user: null });
  },

  /**
   * initialize — Uygulama başladığında mevcut token ile kullanıcı bilgisini çeker.
   * Sayfa yenilendiğinde (F5) oturum korunur.
   *
   * localStorage'da access_token varsa → /api/users/me ile kullanıcıyı çek.
   * Token süresi dolmuşsa → apiClient otomatik refresh dener.
   */
  initialize: async () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      set({ isInitialized: true });
      return;
    }

    const res = await authApi.getMe();
    if (res.success && res.data) {
      set({ user: res.data, isInitialized: true });
    } else {
      clearTokens();
      set({ isInitialized: true });
    }
  },

  clearError: () => set({ error: null }),

  updateUser: (partial) =>
    set((state) => ({
      user: state.user ? { ...state.user, ...partial } : null,
    })),
}));
