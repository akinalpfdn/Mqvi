-- 004_invites_update.sql
-- Invite sistemi güncellemesi:
-- 1. Server tablosuna invite_required kolonu ekle (admin toggle — true ise kayıt için davet kodu zorunlu)
--
-- Not: invites tablosu zaten 001_init.sql'de oluşturuldu (code, created_by, max_uses, uses, expires_at, created_at).
-- Bu migration sadece server tablosuna invite_required ekler.

ALTER TABLE server ADD COLUMN invite_required INTEGER NOT NULL DEFAULT 0;
