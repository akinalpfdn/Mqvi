-- Make username lookups and uniqueness checks case-insensitive.
-- "KeR", "ker", "KER" are all treated as the same username.
-- Original casing is preserved for display purposes.

-- Drop the default case-sensitive unique index and replace with NOCASE.
-- SQLite's built-in UNIQUE on column definition cannot be altered,
-- but a unique index overrides it for constraint checking.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
