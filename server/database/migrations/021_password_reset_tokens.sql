-- 021: Password Reset Tokens tablosu.
--
-- Şifre sıfırlama akışı:
-- 1. Kullanıcı email girer → backend token üretir
-- 2. Token'ın SHA256 hash'i bu tabloya kaydedilir (güvenlik: plaintext saklanmaz)
-- 3. Plaintext token email ile gönderilir
-- 4. Kullanıcı token'ı geri gönderir → backend hash'leyip karşılaştırır
-- 5. Eşleşme varsa ve süresi dolmamışsa → şifre güncellenir, token silinir
--
-- user_id CASCADE: Kullanıcı silinirse token'ları da silinir.
-- token_hash UNIQUE: Aynı hash iki kez kaydedilemez (collision koruması).
-- expires_at: Token'ın geçerlilik süresi (20 dakika).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
