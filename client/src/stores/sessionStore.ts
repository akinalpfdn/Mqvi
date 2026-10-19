/**
 * Session Store — the account's signed-in devices, for the active-devices screen.
 */

import { create } from "zustand";
import * as sessionsApi from "../api/sessions";
import type { DeviceSession } from "../types";

type SessionState = {
  sessions: DeviceSession[];
  isLoading: boolean;
  /** The last load failed; the list shown (if any) may be stale. */
  loadFailed: boolean;

  fetchSessions: () => Promise<void>;
  /** Signs one other device out. Returns false when the server refused. */
  revokeSession: (id: string) => Promise<boolean>;
  /** Signs every device but this one out. Returns false when the server refused. */
  revokeOtherSessions: () => Promise<boolean>;
  reset: () => void;
};

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  isLoading: false,
  loadFailed: false,

  fetchSessions: async () => {
    set({ isLoading: true });
    const res = await sessionsApi.listSessions();
    if (res.success && res.data) {
      set({ sessions: res.data, isLoading: false, loadFailed: false });
    } else {
      set({ isLoading: false, loadFailed: true });
    }
  },

  revokeSession: async (id) => {
    const res = await sessionsApi.revokeSession(id);
    if (!res.success) return false;
    set((state) => ({ sessions: state.sessions.filter((s) => s.id !== id) }));
    return true;
  },

  revokeOtherSessions: async () => {
    const res = await sessionsApi.revokeOtherSessions();
    if (!res.success) return false;
    set((state) => ({ sessions: state.sessions.filter((s) => s.is_current) }));
    return true;
  },

  reset: () => set({ sessions: [], isLoading: false, loadFailed: false }),
}));
