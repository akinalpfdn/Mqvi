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

/** Backend'deki permission sabitleri (models/role.go ile eşleşir) */
export const Permissions = {
  ManageChannels: 1,
  ManageRoles: 2,
  KickMembers: 4,
  BanMembers: 8,
  ManageMessages: 16,
  SendMessages: 32,
  ReadMessages: 64,
  Connect: 128,
  Speak: 256,
  Admin: 512,
  ManageInvites: 1024,
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
