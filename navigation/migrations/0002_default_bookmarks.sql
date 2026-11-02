-- Persist initialization independently of the bookmarks, so an intentionally empty list stays empty.
CREATE TABLE IF NOT EXISTS nav_bookmark_setup (
  address_id INTEGER PRIMARY KEY REFERENCES address(id) ON DELETE CASCADE,
  initialized_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO nav_bookmark_setup(address_id) SELECT DISTINCT address_id FROM nav_bookmarks;
