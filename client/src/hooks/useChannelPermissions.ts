/**
 * useChannelPermissions — Kanal bazlı effective permission hook'u.
 *
 * Bu hook, mevcut kullanıcının belirli bir kanaldaki yetkilerini hesaplar.
 * memberStore'dan kullanıcının rollerini ve effective_permissions'ını,
 * channelPermissionStore'dan o kanaldaki override'ları alır,
 * ve resolveChannelPermissions ile Discord algoritmasını uygular.
 *
 * Kullanım:
 *   const { hasChannelPerm, channelPerms } = useChannelPermissions(channelId);
 *   if (hasChannelPerm(Permissions.SendMessages)) { ... }
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

  // Mevcut kullanıcının üyelik bilgisi (rolleri + effective_permissions içerir)
  const currentMember = useMemo(
    () => members.find((m) => m.id === currentUser?.id),
    [members, currentUser?.id]
  );

  // Bu kanaldaki override'lar
  const overrides = channelID ? getOverrides(channelID) : [];

  // Kullanıcının rol ID'leri
  const roleIds = useMemo(
    () => currentMember?.roles.map((r) => r.id) ?? [],
    [currentMember?.roles]
  );

  // Kanal bazlı effective permissions hesapla
  const channelPerms = useMemo(() => {
    const base = currentMember?.effective_permissions ?? 0;
    if (!channelID || overrides.length === 0) return base;
    return resolveChannelPermissions(base, roleIds, overrides);
  }, [currentMember?.effective_permissions, channelID, roleIds, overrides]);

  // Convenience fonksiyon: belirli bir yetkinin var olup olmadığını kontrol et
  const hasChannelPerm = useMemo(() => {
    return (perm: Permission): boolean => {
      if ((channelPerms & Permissions.Admin) !== 0) return true;
      return (channelPerms & perm) !== 0;
    };
  }, [channelPerms]);

  return { channelPerms, hasChannelPerm };
}
