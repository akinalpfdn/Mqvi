-- Repurpose the dead invite_required flag as is_public: the discovery toggle for the upcoming
-- public servers directory. invite_required never gated anything after the multi-server migration,
-- so it is renamed rather than left as dead weight. All rows reset to private (0) because "public"
-- is the inverse concept and no server should be public until the directory feature ships.
ALTER TABLE servers RENAME COLUMN invite_required TO is_public;
UPDATE servers SET is_public = 0;
