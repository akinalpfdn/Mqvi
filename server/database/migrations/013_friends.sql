-- 013_friends.sql
-- Friendship system table.
--
-- Single table differentiated by status:
--   "pending"  → request sent, not yet accepted
--   "accepted" → friendship is active
--   "blocked"  → user is blocked
--
-- user_id: the requester / the user who blocked
-- friend_id: the target user
-- For "accepted" status the query is bidirectional (user_id OR friend_id).

CREATE TABLE IF NOT EXISTS friendships (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    friend_id  TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id)   REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(friend_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, friend_id)
);

-- Indexes for query performance:
-- Quickly find a user's incoming requests (friend_id = me AND status = 'pending')
CREATE INDEX IF NOT EXISTS idx_friendships_friend_status ON friendships(friend_id, status);
-- Find a user's outgoing requests and friends
CREATE INDEX IF NOT EXISTS idx_friendships_user_status ON friendships(user_id, status);
