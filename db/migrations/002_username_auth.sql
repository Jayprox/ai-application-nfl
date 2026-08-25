-- =========================================================================
-- Migration: switch users to username-based login
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for the original schema.sql). Safe whether the users table is
-- still empty or already has rows — the backfill UPDATE just affects 0
-- rows if it's empty.
--
-- Email becomes optional going forward; email verification for a future
-- self-serve signup flow is backlogged (see vibe-coding-checklist.md
-- Phase 3 backlog).
-- =========================================================================

ALTER TABLE users ADD COLUMN username TEXT;

-- Backfill any existing rows (username derived from email) before making
-- the column required — no-op if the table is empty.
UPDATE users SET username = split_part(email, '@', 1) WHERE username IS NULL AND email IS NOT NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
