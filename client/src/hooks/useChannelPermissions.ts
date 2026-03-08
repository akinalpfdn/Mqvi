/**
 * useChannelPermissions — Effective channel permission hook.
 *
 * Combines user's base permissions, role IDs, and channel overrides
 * using resolveChannelPermissions (Discord algorithm: (base & ~deny) | allow).
 */

import { useMemo } from "react";
import { useAuthStore } from "../stores/authStore";
import { useMemberStore } from "../stores/memberStore";
import { useChannelPermissionStore } from "../stores/channelPermissionStore";
import {
  resolveChannelPermissions,
  Permissions,
  type Permission,
} from "../utils/permissions";

export function useChannelPermissions(channelID: string | null) {
  const currentUser = useAuthStore((s) => s.user);
  const members = useMemberStore((s) => s.members);
  const getOverrides = useChannelPermissionStore((s) => s.getOverrides);

  const currentMember = useMemo(
    () => members.find((m) => m.id === currentUser?.id),
    [members, currentUser?.id]
  );

  const overrides = channelID ? getOverrides(channelID) : [];

  const roleIds = useMemo(
    () => currentMember?.roles.map((r) => r.id) ?? [],
    [currentMember?.roles]
  );

  const channelPerms = useMemo(() => {
    const base = currentMember?.effective_permissions ?? 0;
    if (!channelID || overrides.length === 0) return base;
    return resolveChannelPermissions(base, roleIds, overrides);
  }, [currentMember?.effective_permissions, channelID, roleIds, overrides]);

  const hasChannelPerm = useMemo(() => {
    return (perm: Permission): boolean => {
      if ((channelPerms & Permissions.Admin) !== 0) return true;
      return (channelPerms & perm) !== 0;
    };
  }, [channelPerms]);

  return { channelPerms, hasChannelPerm };
}
