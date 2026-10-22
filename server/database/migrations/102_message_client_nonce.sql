-- 102: client_nonce makes sending idempotent. The client generates it per message and resends the
-- same one on retry; the unique index per author turns a repeat into "return the stored message"
-- instead of a second copy. NULL (older clients, server-made messages) is never unique-checked.
ALTER TABLE messages ADD COLUMN client_nonce TEXT;
ALTER TABLE dm_messages ADD COLUMN client_nonce TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_author_nonce
    ON messages(user_id, client_nonce) WHERE client_nonce IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_messages_author_nonce
    ON dm_messages(user_id, client_nonce) WHERE client_nonce IS NOT NULL;
