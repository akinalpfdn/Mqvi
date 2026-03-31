/**
 * Permission bitfield helpers.
 *
 * Must match backend models/role.go permission values.
 * Effective permissions = OR of all user's role permissions.
 * Check with bitwise AND: (perms & flag) !== 0.
 */

/** Backend permission constants (must match models/role.go exactly) */
export const Permissions = {
  ManageChannels: 1,
  ManageRoles: 2,
  KickMembers: 4,
  BanMembers: 8,
  ManageMessages: 16,
  SendMessages: 32,
  ConnectVoice: 64,
  Speak: 128,
  Stream: 256,
  Admin: 512,
  ManageInvites: 1024,
  ReadMessages: 2048,
  ViewChannel: 4096,
  MoveMembers: 8192,
  MuteMembers: 16384,
  DeafenMembers: 32768,
  UseSoundboard: 65536,
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

/** Checks if user has a specific permission. Admin bypasses all checks. */
export function hasPermission(
  effectivePerms: number,
  perm: Permission
): boolean {
  if ((effectivePerms & Permissions.Admin) !== 0) return true;
  return (effectivePerms & perm) !== 0;
}

/**
 * Permissions that can be overridden per-channel.
 * Server management perms (ManageChannels, ManageRoles, Kick, Ban, Admin, ManageInvites)
 * cannot be overridden at channel level.
 */
export const ChannelOverridablePerms =
  Permissions.SendMessages |
  Permissions.ReadMessages |
  Permissions.ManageMessages |
  Permissions.ConnectVoice |
  Permissions.Speak |
  Permissions.Stream |
  Permissions.ViewChannel |
  Permissions.MoveMembers |
  Permissions.MuteMembers |
  Permissions.DeafenMembers;

/**
 * Resolves channel-level effective permissions using Discord's algorithm:
 * 1. base = OR of all role permissions
 * 2. Admin -> all permissions (bypass overrides)
 * 3. OR all allow/deny from user's role overrides
 * 4. effective = (base & ~deny) | allow
 */
export function resolveChannelPermissions(
  basePermissions: number,
  roleIds: string[],
  overrides: { role_id: string; allow: number; deny: number }[]
): number {
  // Admin bypasses all overrides
  if ((basePermissions & Permissions.Admin) !== 0) {
    return 131071; // PermAll = (1 << 17) - 1
  }

  const roleIdSet = new Set(roleIds);
  let channelAllow = 0;
  let channelDeny = 0;

  for (const o of overrides) {
    if (roleIdSet.has(o.role_id)) {
      channelAllow |= o.allow;
      channelDeny |= o.deny;
    }
  }

  if (channelAllow === 0 && channelDeny === 0) {
    return basePermissions;
  }

  return (basePermissions & ~channelDeny) | channelAllow;
}
