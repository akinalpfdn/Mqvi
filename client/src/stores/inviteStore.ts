/**
 * Invite Store — Invite code management.
 */

import { create } from "zustand";
import * as inviteApi from "../api/invites";
import type { Invite } from "../types";

/** Stable empty ref for selectors */
const EMPTY_INVITES: Invite[] = [];

type InviteState = {
  invites: Invite[];
  isLoading: boolean;
  /** Which server the current invites belong to */
  _loadedServerId: string | null;

  fetchInvites: (serverId: string) => Promise<void>;
  createInvite: (serverId: string, maxUses: number, expiresIn: number) => Promise<Invite | null>;
  /** Get existing permanent invite or create one. Used by "Copy Invite Link" flows. */
  getOrCreatePermanentInvite: (serverId: string) => Promise<Invite | null>;
  deleteInvite: (serverId: string, code: string) => Promise<boolean>;
  clearForServerSwitch: () => void;
};

export const useInviteStore = create<InviteState>((set, get) => ({
  invites: EMPTY_INVITES,
  isLoading: false,
  _loadedServerId: null,

  fetchInvites: async (serverId: string) => {
    set({ isLoading: true });

    const res = await inviteApi.getInvites(serverId);
    if (res.success && res.data) {
      set({ invites: res.data, isLoading: false, _loadedServerId: serverId });
    } else {
      set({ isLoading: false });
    }
  },

  createInvite: async (serverId: string, maxUses: number, expiresIn: number) => {
    const res = await inviteApi.createInvite(serverId, {
      max_uses: maxUses,
      expires_in: expiresIn,
    });

    if (res.success && res.data) {
      // Full refetch for creator info (create endpoint returns bare Invite)
      await get().fetchInvites(serverId);
      return res.data;
    }

    return null;
  },

  getOrCreatePermanentInvite: async (serverId: string) => {
    // If cached invites are for a different server, refetch
    if (get()._loadedServerId !== serverId || get().invites.length === 0) {
      await get().fetchInvites(serverId);
    }

    // Find existing permanent invite (unlimited uses, no expiry)
    const existing = get().invites.find(
      (inv) => inv.max_uses === 0 && inv.expires_at === null,
    );
    if (existing) return existing;

    return get().createInvite(serverId, 0, 0);
  },

  deleteInvite: async (serverId: string, code: string) => {
    const res = await inviteApi.deleteInvite(serverId, code);

    if (res.success) {
      set((state) => ({
        invites: state.invites.filter((inv) => inv.code !== code),
      }));
      return true;
    }

    return false;
  },

  clearForServerSwitch: () => {
    set({ invites: EMPTY_INVITES, _loadedServerId: null });
  },
}));
