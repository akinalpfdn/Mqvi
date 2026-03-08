-- Badge system: badge templates and user-badge assignments.

CREATE TABLE IF NOT EXISTS badges (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT '',
    icon_type  TEXT NOT NULL DEFAULT 'builtin' CHECK(icon_type IN ('builtin', 'custom')),
    color1     TEXT NOT NULL DEFAULT '#5865F2',
    color2     TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_badges (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_id    TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    assigned_by TEXT NOT NULL REFERENCES users(id),
    assigned_at DATETIME NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_badge ON user_badges(badge_id);
