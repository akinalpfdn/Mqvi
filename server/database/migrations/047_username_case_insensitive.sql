-- Make username lookups and uniqueness checks case-insensitive.
-- "KeR", "ker", "KER" are all treated as the same username.
-- Original casing is preserved for display purposes.

-- Resolve any existing case-insensitive duplicates before adding the index.
-- For each group of duplicates the oldest row keeps its name,
-- newer rows get a numeric suffix (_1, _2, etc).
UPDATE users
SET username = username || '_' || CAST(
    (SELECT COUNT(*)
     FROM users u2
     WHERE u2.username COLLATE NOCASE = users.username COLLATE NOCASE
       AND u2.created_at < users.created_at) AS TEXT)
WHERE rowid NOT IN (
    SELECT MIN(rowid)
    FROM users
    GROUP BY username COLLATE NOCASE
)
AND EXISTS (
    SELECT 1
    FROM users u3
    WHERE u3.username COLLATE NOCASE = users.username COLLATE NOCASE
      AND u3.rowid <> users.rowid
);

-- Now safe to create the case-insensitive unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
