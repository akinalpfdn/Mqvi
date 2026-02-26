-- 015_voice_moderation_perms.sql
-- 3 yeni voice moderation yetkisi:
--   PermMoveMembers   = 8192  (üyeleri voice kanallar arası taşıma + voice'tan atma)
--   PermMuteMembers   = 16384 (üyeleri sunucu genelinde susturma)
--   PermDeafenMembers = 32768 (üyeleri sunucu genelinde sağırlaştırma)
--
-- Owner/Admin zaten PermAdmin (512) ile tüm yetkilere sahip (Has() bypass).
-- Moderator rolüne explicit ekliyoruz.
UPDATE roles SET permissions = permissions | 8192 | 16384 | 32768
  WHERE id IN ('owner', 'admin', 'moderator');
