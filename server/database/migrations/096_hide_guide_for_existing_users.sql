-- 096: The onboarding guide is for new accounts. Everyone who already has an account when this
-- runs starts with it hidden (they can bring it back from Settings → Help); accounts created
-- afterwards keep the column default and see it.
UPDATE users SET guide_hidden = 1;
