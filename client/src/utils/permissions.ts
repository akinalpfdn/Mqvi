/**
 * Permission bitfield helper fonksiyonları.
 *
 * Backend'deki models/role.go'daki permission sistemiyle uyumlu.
 * Bitfield nedir?
 * Her permission bir bit ile temsil edilir: 1, 2, 4, 8, 16...
 * Bir kullanıcının tüm rolleri OR'lanarak effective permissions hesaplanır.
 * `has()` fonksiyonu bitwise AND ile kontrol eder.
 *
 * Örnek:
 *   effectivePerms = 0b1010 (2 + 8 = 10)
 *   PermSendMessages = 0b0010 (2)
 *   10 & 2 = 2 → truthy → yetki var
 */

/** Backend'deki permission sabitleri (models/role.go ile BİREBİR eşleşir) */
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
} as const;

/** Permission türü (type-safe) */
export type Permission = (typeof Permissions)[keyof typeof Permissions];

/**
 * hasPermission — Kullanıcının belirli bir yetkiye sahip olup olmadığını kontrol eder.
 *
 * Admin yetkisi tüm diğer yetkileri kapsar (backend'deki Has() metodu gibi).
 *
 * @param effectivePerms - Kullanıcının tüm rollerinin OR'lanmış yetki değeri
 * @param perm - Kontrol edilecek yetki
 */
export function hasPermission(
  effectivePerms: number,
  perm: Permission
): boolean {
  // Admin her şeye yetkili
  if ((effectivePerms & Permissions.Admin) !== 0) return true;
  return (effectivePerms & perm) !== 0;
}

/**
 * ChannelOverridablePerms — Kanal bazında override edilebilecek permission'lar.
 *
 * Backend'deki models.ChannelOverridablePerms ile birebir eşleşir.
 * Sunucu yönetim yetkileri (ManageChannels, ManageRoles, Kick, Ban, Admin, ManageInvites)
 * kanal bazında override edilemez.
 */
export const ChannelOverridablePerms =
  Permissions.SendMessages |
  Permissions.ReadMessages |
  Permissions.ManageMessages |
  Permissions.ConnectVoice |
  Permissions.Speak |
  Permissions.Stream;

/**
 * resolveChannelPermissions — Kanal bazlı effective permissions hesaplar.
 *
 * Discord algoritması:
 * 1. base = tüm rollerin OR'u (effective_permissions)
 * 2. Admin → tüm yetkiler (override bypass)
 * 3. Kullanıcının rollerine ait override'ların allow/deny'larını OR'la
 * 4. effective = (base & ~deny) | allow
 *
 * @param basePermissions - Kullanıcının tüm rollerinin OR'lanmış yetkileri
 * @param roleIds - Kullanıcının sahip olduğu rol ID'leri
 * @param overrides - Bu kanaldaki tüm override'lar
 * @returns Kanal bazlı effective permissions
 */
export function resolveChannelPermissions(
  basePermissions: number,
  roleIds: string[],
  overrides: { role_id: string; allow: number; deny: number }[]
): number {
  // Admin tüm override'ları bypass eder
  if ((basePermissions & Permissions.Admin) !== 0) {
    // PermAll = (1 << 12) - 1 = 4095
    return 4095;
  }

  // Kullanıcının rollerine ait override'ları filtrele
  const roleIdSet = new Set(roleIds);
  let channelAllow = 0;
  let channelDeny = 0;

  for (const o of overrides) {
    if (roleIdSet.has(o.role_id)) {
      channelAllow |= o.allow;
      channelDeny |= o.deny;
    }
  }

  // Override yoksa base döner
  if (channelAllow === 0 && channelDeny === 0) {
    return basePermissions;
  }

  // Discord formülü: effective = (base & ~deny) | allow
  return (basePermissions & ~channelDeny) | channelAllow;
}
