-- 099: What the active-devices screen shows per session, and push tokens bound to the session that
-- registered them. ip/city/country are the last seen values and go with the session; the legal
-- traffic log (5651) is a separate concern and does not live here.
-- ON DELETE CASCADE: revoking or signing out a device stops its notifications in the same write.

ALTER TABLE sessions ADD COLUMN platform TEXT;
ALTER TABLE sessions ADD COLUMN device_label TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN city TEXT;
ALTER TABLE sessions ADD COLUMN country TEXT;

ALTER TABLE push_tokens ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_push_tokens_session ON push_tokens(session_id);
