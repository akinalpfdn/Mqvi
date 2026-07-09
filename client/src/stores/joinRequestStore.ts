/**
 * joinRequestStore — per-server pending join-request counts for PermApproveMembers holders.
 * Drives the sidebar badge and the requests screen's live refresh. Kept in sync by the
 * `join_request_update` WS event and by explicit count/list fetches.
 */

import { create } from "zustand";
import { getJoinRequestCount } from "../api/joinRequests";

type JoinRequestState = {
  /** serverId -> number of pending join requests. */
  pendingCounts: Record<string, number>;
  setPendingCount: (serverId: string, count: number) => void;
  fetchCount: (serverId: string) => Promise<void>;
  clear: () => void;
};

export const useJoinRequestStore = create<JoinRequestState>((set) => ({
  pendingCounts: {},

  setPendingCount: (serverId, count) =>
    set((s) => ({ pendingCounts: { ...s.pendingCounts, [serverId]: count } })),

  fetchCount: async (serverId) => {
    const res = await getJoinRequestCount(serverId);
    if (res.success && res.data) {
      set((s) => ({
        pendingCounts: { ...s.pendingCounts, [serverId]: res.data!.count },
      }));
    }
  },

  clear: () => set({ pendingCounts: {} }),
}));
