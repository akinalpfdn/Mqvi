-- 100: Push tokens registered before 099 have no session_id, so ON DELETE CASCADE cannot remove
-- them when their device signs out — a phone signed out from the devices screen kept receiving
-- notifications. Which unbound token belongs to which device is unknowable, so any sign-out of the
-- user's sessions drops all of their unbound tokens. Devices still signed in register again on
-- their next launch (or within 30 minutes), and that registration carries a session.

CREATE TRIGGER IF NOT EXISTS sessions_ad_unbound_push_tokens AFTER DELETE ON sessions
BEGIN
    DELETE FROM push_tokens WHERE user_id = OLD.user_id AND session_id IS NULL;
END;
