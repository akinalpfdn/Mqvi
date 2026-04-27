-- Migration 036: E2EE signing key
--
-- Identity key (X25519) → Diffie-Hellman key agreement
-- Signing key (Ed25519) → signed prekey signature verification
--
-- Both are derived from the same private key but have different curve representations.
-- Other devices need the signing key to verify the signed prekey signature.
ALTER TABLE user_devices ADD COLUMN signing_key TEXT;
