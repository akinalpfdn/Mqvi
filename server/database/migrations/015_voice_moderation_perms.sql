-- 015_voice_moderation_perms.sql
-- 3 new voice moderation permissions:
--   PermMoveMembers   = 8192  (move members between voice channels + disconnect from voice)
--   PermMuteMembers   = 16384 (server-wide mute members)
--   PermDeafenMembers = 32768 (server-wide deafen members)
--
-- Owner/Admin already have all permissions via PermAdmin (512) (Has() bypass).
-- We add them explicitly to the Moderator role.
UPDATE roles SET permissions = permissions | 8192 | 16384 | 32768
  WHERE id IN ('owner', 'admin', 'moderator');
