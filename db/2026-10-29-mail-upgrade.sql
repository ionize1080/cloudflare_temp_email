-- Apply once after checking PRAGMA table_info. Additive only; keeps all mail.
ALTER TABLE raw_mails ADD COLUMN metadata TEXT;
ALTER TABLE address ADD COLUMN source_meta TEXT;
CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);
INSERT INTO settings (key, value) VALUES ('db_version', 'v0.0.5') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
