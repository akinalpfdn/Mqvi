-- Migration 036: E2EE signing key
--
-- Identity key (X25519) → Diffie-Hellman key agreement
-- Signing key (Ed25519) → Signed prekey imza doğrulama
--
-- Aynı private key'den türetilirler ama farklı curve representation'ları vardır.
-- Diğer cihazlar signed prekey imzasını doğrulamak için signing key'e ihtiyaç duyar.
ALTER TABLE user_devices ADD COLUMN signing_key TEXT;
