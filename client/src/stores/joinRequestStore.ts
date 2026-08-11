/**
 * joinRequestStore — per-server pending join-request counts for PermApproveMembers holders.
 * Drives the sidebar badge and the requests screen's live refresh. Kept in sync by the
 * `join_request_update` WS event and by explicit count/list fetches.
 */

import { create } from "zustand";
import {
  getJoinRequestCount,
  approveJoinRequest,
  rejectJoinRequest,
} from "../api/joinRequests";
import type { MutationResult } from "../types";

type JoinRequestState = {
  /** serverId -> number of pending join requests. */
  pendingCounts: Record<string, number>;
  setPendingCount: (serverId: string, count: number) => void;
  fetchCount: (serverId: string) => Promise<void>;

  /**
   * Deciding a request drops the badge count by one straight away.
   *
   * The screen used to call the api directly and filter its own list, leaving the count untouched:
   * the row disappeared while the sidebar still claimed a request was pending, until the
   * join_request_update event arrived to correct it.
   */
  approve: (serverId: string, userId: string) => Promise<MutationResult>;
  reject: (serverId: string, userId: string) => Promise<MutationResult>;

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

  approve: async (serverId, userId) => {
    const res = await approveJoinRequest(serverId, userId);
    if (!res.success) return { ok: false, error: res.error };
    decrement(set, serverId);
    return { ok: true };
  },

  reject: async (serverId, userId) => {
    const res = await rejectJoinRequest(serverId, userId);
    if (!res.success) return { ok: false, error: res.error };
    decrement(set, serverId);
    return { ok: true };
  },

  clear: () => set({ pendingCounts: {} }),
}));

/**
 * Drop one from the badge, never below zero.
 *
 * The authoritative count arrives in join_request_update; this only has to be right until then, and
 * two moderators deciding at once must not push it negative.
 */
function decrement(
  set: (fn: (s: JoinRequestState) => Partial<JoinRequestState>) => void,
  serverId: string
): void {
  set((s) => ({
    pendingCounts: {
      ...s.pendingCounts,
      [serverId]: Math.max(0, (s.pendingCounts[serverId] ?? 0) - 1),
    },
  }));
}
