-- 033: E2EE device registration — device identity and prekey management for Signal Protocol.
--
-- For E2EE (End-to-End Encryption) every device (browser, Electron) must have an
-- independent cryptographic identity. The Signal Protocol's X3DH (Extended Triple
-- Diffie-Hellman) flow works as follows:
--
-- 1. Each device uploads a "prekey bundle" upon registration:
--    - identity_key: Long-lived Curve25519 public key (represents the device identity)
--    - signed_prekey: Medium-term key, signed with identity_key (rotated periodically)
--    - one_time_prekeys: Single-use ephemeral keys (consumed on first message)
--
-- 2. When Alice wants to send her first message to Bob:
--    - Fetches Bob's prekey bundle from the server
--    - Derives a shared secret via X3DH
--    - Encrypts the message with Double Ratchet
--    - Server stores the encrypted blob and NEVER sees its contents
--
-- 3. A one-time prekey is deleted once consumed.
--    When the pool runs low the server notifies the client over WS.

-- ═══════════════════════════════════════════════════════════
-- user_devices: Independent device records for each user.
-- A user may sign in from multiple devices (web + desktop).
-- A separate Signal session is created for each device.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_devices (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    display_name TEXT,
    identity_key TEXT NOT NULL,
    signed_prekey TEXT NOT NULL,
    signed_prekey_id INTEGER NOT NULL,
    signed_prekey_signature TEXT NOT NULL,
    registration_id INTEGER NOT NULL DEFAULT 0,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);

-- ═══════════════════════════════════════════════════════════
-- device_one_time_prekeys: One-time prekey pool for each device.
-- One is consumed during X3DH (atomic DELETE ... RETURNING).
-- When the pool drops below 10 the server emits a "prekey_low" WS event to the client.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS device_one_time_prekeys (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    prekey_id INTEGER NOT NULL,
    public_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id, prekey_id),
    FOREIGN KEY (user_id, device_id) REFERENCES user_devices(user_id, device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_otp_device ON device_one_time_prekeys(user_id, device_id);
