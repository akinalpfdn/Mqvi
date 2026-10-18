-- 101: Undo 100. Its trigger dropped a user's unbound push tokens on EVERY session delete, and the
-- daily sweep deletes expired sessions — thousands of pre-098 rows on the first run — so nearly
-- every user with an older phone would have lost their push registration at once. Unbound tokens
-- are now pruned only when the user signs devices out (SessionRepository revoke methods and the
-- password-change transaction), never on expiry.

DROP TRIGGER IF EXISTS sessions_ad_unbound_push_tokens;
