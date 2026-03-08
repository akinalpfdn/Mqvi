/**
 * Badge store — manages badge templates and user-badge assignments.
 */

import { create } from "zustand";
import type { Badge, UserBadge } from "../types";
import * as badgeApi from "../api/badges";

const EMPTY_BADGES: Badge[] = [];
const EMPTY_USER_BADGES: UserBadge[] = [];

type BadgeState = {
  /** All badge templates. */
  badges: Badge[];
  /** Map of userId -> UserBadge[] for cached user badges. */
  userBadgesMap: Record<string, UserBadge[]>;
  /** Whether badge templates have been fetched. */
  loaded: boolean;

  // Actions
  fetchBadges: () => Promise<void>;
  createBadge: (body: {
    name: string;
    icon: string;
    icon_type: "builtin" | "custom";
    color1: string;
    color2: string | null;
  }) => Promise<Badge | null>;
  updateBadge: (badgeId: string, body: {
    name: string;
    icon: string;
    icon_type: "builtin" | "custom";
    color1: string;
    color2: string | null;
  }) => Promise<Badge | null>;
  deleteBadge: (badgeId: string) => Promise<boolean>;
  assignBadge: (badgeId: string, userId: string) => Promise<UserBadge | null>;
  unassignBadge: (badgeId: string, userId: string) => Promise<boolean>;
  fetchUserBadges: (userId: string) => Promise<UserBadge[]>;

  // WS event handlers
  handleBadgeAssign: (data: { user_id: string; user_badge: UserBadge }) => void;
  handleBadgeUnassign: (data: { user_id: string; badge_id: string }) => void;
};

export const useBadgeStore = create<BadgeState>((set) => ({
  badges: EMPTY_BADGES,
  userBadgesMap: {},
  loaded: false,

  fetchBadges: async () => {
    const res = await badgeApi.listBadges();
    if (res.success && res.data) {
      set({ badges: res.data, loaded: true });
    }
  },

  createBadge: async (body) => {
    const res = await badgeApi.createBadge(body);
    if (res.success && res.data) {
      set((s) => ({ badges: [res.data!, ...s.badges] }));
      return res.data;
    }
    return null;
  },

  updateBadge: async (badgeId, body) => {
    const res = await badgeApi.updateBadge(badgeId, body);
    if (res.success && res.data) {
      const updated = res.data;
      set((s) => ({
        badges: s.badges.map((b) => (b.id === badgeId ? updated : b)),
        // Update nested badge in all userBadgesMap entries
        userBadgesMap: Object.fromEntries(
          Object.entries(s.userBadgesMap).map(([uid, ubs]) => [
            uid,
            ubs.map((ub) =>
              ub.badge_id === badgeId ? { ...ub, badge: updated } : ub
            ),
          ])
        ),
      }));
      return updated;
    }
    return null;
  },

  deleteBadge: async (badgeId) => {
    const res = await badgeApi.deleteBadge(badgeId);
    if (res.success) {
      set((s) => ({ badges: s.badges.filter((b) => b.id !== badgeId) }));
      return true;
    }
    return false;
  },

  assignBadge: async (badgeId, userId) => {
    const res = await badgeApi.assignBadge(badgeId, userId);
    if (res.success && res.data) {
      const ub = res.data;
      set((s) => {
        const existing = s.userBadgesMap[userId] ?? [];
        // Skip if already present (WS event may have arrived first)
        if (existing.some((b) => b.badge_id === badgeId)) return s;
        return {
          userBadgesMap: {
            ...s.userBadgesMap,
            [userId]: [...existing, ub],
          },
        };
      });
      return ub;
    }
    return null;
  },

  unassignBadge: async (badgeId, userId) => {
    const res = await badgeApi.unassignBadge(badgeId, userId);
    if (res.success) {
      set((s) => ({
        userBadgesMap: {
          ...s.userBadgesMap,
          [userId]: (s.userBadgesMap[userId] ?? []).filter(
            (ub) => ub.badge_id !== badgeId
          ),
        },
      }));
      return true;
    }
    return false;
  },

  fetchUserBadges: async (userId) => {
    const res = await badgeApi.getUserBadges(userId);
    if (res.success && res.data) {
      set((s) => ({
        userBadgesMap: { ...s.userBadgesMap, [userId]: res.data! },
      }));
      return res.data;
    }
    return EMPTY_USER_BADGES;
  },

  // WS event handlers
  handleBadgeAssign: (data) => {
    const { user_id, user_badge } = data;
    set((s) => {
      const existing = s.userBadgesMap[user_id] ?? [];
      // Deduplicate — assignBadge action already added it locally
      if (existing.some((ub) => ub.badge_id === user_badge.badge_id)) return s;
      return {
        userBadgesMap: {
          ...s.userBadgesMap,
          [user_id]: [...existing, user_badge],
        },
      };
    });
  },

  handleBadgeUnassign: (data) => {
    const { user_id, badge_id } = data;
    set((s) => ({
      userBadgesMap: {
        ...s.userBadgesMap,
        [user_id]: (s.userBadgesMap[user_id] ?? []).filter(
          (ub) => ub.badge_id !== badge_id
        ),
      },
    }));
  },
}));
