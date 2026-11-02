-- Additive: shares mailbox identity; never changes mail data or its migration table.
CREATE TABLE IF NOT EXISTS nav_sessions (
  token_hash TEXT PRIMARY KEY,
  address_id INTEGER NOT NULL REFERENCES address(id) ON DELETE CASCADE,
  password_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nav_session_expiry ON nav_sessions(expires_at);
CREATE TABLE IF NOT EXISTS nav_bookmarks (
  id TEXT PRIMARY KEY,
  address_id INTEGER NOT NULL REFERENCES address(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS nav_bookmark_owner ON nav_bookmarks(address_id, position);
CREATE TABLE IF NOT EXISTS nav_preferences (
  address_id INTEGER PRIMARY KEY REFERENCES address(id) ON DELETE CASCADE,
  wallpaper_mode TEXT NOT NULL DEFAULT 'bing',
  wallpaper_url TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#e8f0fe',
  search_engine TEXT NOT NULL DEFAULT 'google'
);
CREATE TABLE IF NOT EXISTS nav_invites (
  code_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 100),
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS nav_registrations (
  address_id INTEGER PRIMARY KEY REFERENCES address(id) ON DELETE CASCADE,
  invite_hash TEXT NOT NULL REFERENCES nav_invites(code_hash),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TRIGGER IF NOT EXISTS nav_invite_guard BEFORE INSERT ON nav_registrations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM nav_invites WHERE code_hash = NEW.invite_hash
    AND revoked = 0 AND used < max_uses AND expires_at > unixepoch()
  ) THEN RAISE(ABORT, 'invite_unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS nav_invite_consume AFTER INSERT ON nav_registrations
BEGIN
  UPDATE nav_invites SET used = used + 1 WHERE code_hash = NEW.invite_hash;
END;
CREATE TABLE IF NOT EXISTS nav_wallpapers (
  day TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch())
);
