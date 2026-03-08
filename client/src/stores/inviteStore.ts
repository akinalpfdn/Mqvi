/**
 * Invite Store — Invite code management.
 */

import { create } from "zustand";
import * as inviteApi from "../api/invites";
import { useServerStore } from "./serverStore";
import type { Invite } from "../types";

/** Stable empty ref for selectors */
const EMPTY_INVITES: Invite[] = [];

type InviteState = {
  invites: Invite[];
  isLoading: boolean;

  fetchInvites: () => Promise<void>;
  createInvite: (maxUses: number, expiresIn: number) => Promise<Invite | null>;
  /** Get existing permanent invite or create one. Used by "Copy Invite Link" flows. */
  getOrCreatePermanentInvite: () => Promise<Invite | null>;
  deleteInvite: (code: string) => Promise<boolean>;
};

export const useInviteStore = create<InviteState>((set, get) => ({
  invites: EMPTY_INVITES,
  isLoading: false,

  fetchInvites: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    set({ isLoading: true });

    const res = await inviteApi.getInvites(serverId);
    if (res.success && res.data) {
      set({ invites: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  createInvite: async (maxUses, expiresIn) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return null;
    const res = await inviteApi.createInvite(serverId, {
      max_uses: maxUses,
      expires_in: expiresIn,
    });

    if (res.success && res.data) {
      // Full refetch for creator info (create endpoint returns bare Invite)
      await get().fetchInvites();
      return res.data;
    }

    return null;
  },

  getOrCreatePermanentInvite: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return null;

    if (get().invites.length === 0) {
      await get().fetchInvites();
    }

    // Find existing permanent invite (unlimited uses, no expiry)
    const existing = get().invites.find(
      (inv) => inv.max_uses === 0 && inv.expires_at === null,
    );
    if (existing) return existing;

    return get().createInvite(0, 0);
  },

  deleteInvite: async (code) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const res = await inviteApi.deleteInvite(serverId, code);

    if (res.success) {
      set((state) => ({
        invites: state.invites.filter((inv) => inv.code !== code),
      }));
      return true;
    }

    return false;
  },
}));
