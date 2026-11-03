-- The push protocol a registration enrolled with: 1 (perch payload names, the default) or 2 (relay names).
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS protocol INTEGER NOT NULL DEFAULT 1;
