-- 095: The onboarding guide, per account so it follows the user to every device.
-- guide_hidden: the user hid the guide conversation.
-- guide_done: bitmask of steps ever completed (1 community, 2 message, 4 voice, 8 friend,
-- 16 dm, 32 profile, 64 roles, 128 app);
-- once set a step stays done, even if what completed it is later undone.
ALTER TABLE users ADD COLUMN guide_hidden BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN guide_done INTEGER NOT NULL DEFAULT 0;
