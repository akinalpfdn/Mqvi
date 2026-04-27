-- 004_invites_update.sql
-- Invite system update:
-- 1. Add invite_required column to server table (admin toggle — when true, an invite code is required to register)
--
-- Note: the invites table was already created in 001_init.sql (code, created_by, max_uses, uses, expires_at, created_at).
-- This migration only adds invite_required to the server table.

ALTER TABLE server ADD COLUMN invite_required INTEGER NOT NULL DEFAULT 0;
