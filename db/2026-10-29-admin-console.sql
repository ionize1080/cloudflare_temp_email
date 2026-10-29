-- Additive migration. Inspect table_info before applying to an existing database.
ALTER TABLE address_sender ADD COLUMN requested_at DATETIME;
CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit(created_at);
UPDATE settings SET value = 'v0.0.6', updated_at = CURRENT_TIMESTAMP WHERE key = 'db_version';
