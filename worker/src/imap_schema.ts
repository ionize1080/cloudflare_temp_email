export const IMAP_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS imap_access (\n    address_id INTEGER PRIMARY KEY,\n    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),\n    requested_at DATETIME,\n    reviewed_at DATETIME,\n    created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);",
  "CREATE TABLE IF NOT EXISTS imap_passwords (\n    id TEXT PRIMARY KEY,\n    address_id INTEGER NOT NULL,\n    label TEXT NOT NULL,\n    password_hash TEXT NOT NULL,\n    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n    last_used_at DATETIME\n);",
  "CREATE INDEX IF NOT EXISTS idx_imap_passwords_address ON imap_passwords(address_id);",
  "CREATE TABLE IF NOT EXISTS imap_messages (\n    uid INTEGER PRIMARY KEY AUTOINCREMENT,\n    address_id INTEGER NOT NULL,\n    folder TEXT NOT NULL CHECK(folder IN ('INBOX', 'SENT')),\n    mail_id INTEGER NOT NULL,\n    flags TEXT NOT NULL DEFAULT '[]',\n    UNIQUE(address_id, folder, mail_id)\n);",
  "CREATE INDEX IF NOT EXISTS idx_imap_messages_mail ON imap_messages(folder, mail_id);",
  "CREATE TRIGGER IF NOT EXISTS imap_received_insert AFTER INSERT ON raw_mails BEGIN\n    INSERT OR IGNORE INTO imap_messages(address_id, folder, mail_id) SELECT id, 'INBOX', NEW.id FROM address WHERE name = NEW.address;\nEND;",
  "CREATE TRIGGER IF NOT EXISTS imap_received_delete AFTER DELETE ON raw_mails BEGIN\n    DELETE FROM imap_messages WHERE folder = 'INBOX' AND mail_id = OLD.id;\nEND;",
  "CREATE TRIGGER IF NOT EXISTS imap_sent_insert AFTER INSERT ON sendbox BEGIN\n    INSERT OR IGNORE INTO imap_messages(address_id, folder, mail_id) SELECT id, 'SENT', NEW.id FROM address WHERE name = NEW.address;\nEND;",
  "CREATE TRIGGER IF NOT EXISTS imap_sent_delete AFTER DELETE ON sendbox BEGIN\n    DELETE FROM imap_messages WHERE folder = 'SENT' AND mail_id = OLD.id;\nEND;",
  "CREATE TRIGGER IF NOT EXISTS imap_address_delete AFTER DELETE ON address BEGIN\n    DELETE FROM imap_access WHERE address_id = OLD.id;\n    DELETE FROM imap_passwords WHERE address_id = OLD.id;\n    DELETE FROM imap_messages WHERE address_id = OLD.id;\nEND;",
  "INSERT OR IGNORE INTO imap_messages(address_id, folder, mail_id) SELECT a.id, 'INBOX', m.id FROM raw_mails m JOIN address a ON a.name = m.address ORDER BY m.id;",
  "INSERT OR IGNORE INTO imap_messages(address_id, folder, mail_id) SELECT a.id, 'SENT', m.id FROM sendbox m JOIN address a ON a.name = m.address ORDER BY m.id;",
  "INSERT INTO settings(key, value) VALUES ('db_version', 'v0.0.7') ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
];
