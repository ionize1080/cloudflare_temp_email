CREATE TABLE IF NOT EXISTS imap_access (
    address_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    requested_at DATETIME,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS imap_passwords (
    id TEXT PRIMARY KEY,
    address_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_imap_passwords_address ON imap_passwords(address_id);
CREATE TABLE IF NOT EXISTS imap_messages (
    uid INTEGER PRIMARY KEY AUTOINCREMENT,
    address_id INTEGER NOT NULL,
    folder TEXT NOT NULL CHECK(folder IN ('INBOX', 'SENT')),
    mail_id INTEGER NOT NULL,
    flags TEXT NOT NULL DEFAULT '[]',
    UNIQUE(address_id, folder, mail_id)
);
CREATE INDEX IF NOT EXISTS idx_imap_messages_mail ON imap_messages(folder, mail_id);
CREATE TRIGGER IF NOT EXISTS imap_received_insert AFTER INSERT ON raw_mails BEGIN
    INSERT OR IGNORE INTO imap_messages(address_id, folder, mail_id) SELECT id, 'INBOX', NEW.id FROM address WHERE name = NEW.address;
END;
CREATE TRIGGER IF NOT EXISTS imap_received_delete AFTER DELETE ON raw_mails BEGIN
    DELETE FROM imap_messages WHERE folder = 'INBOX' AND mail_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS imap_sent_insert AFTER INSERT ON sendbox BEGIN
    INSERT OR IGNORE INTO imap_messages(address_id, folder, mail_id) SELECT id, 'SENT', NEW.id FROM address WHERE name = NEW.address;
END;
CREATE TRIGGER IF NOT EXISTS imap_sent_delete AFTER DELETE ON sendbox BEGIN
    DELETE FROM imap_messages WHERE folder = 'SENT' AND mail_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS imap_address_delete AFTER DELETE ON address BEGIN
    DELETE FROM imap_access WHERE address_id = OLD.id;
    DELETE FROM imap_passwords WHERE address_id = OLD.id;
    DELETE FROM imap_messages WHERE address_id = OLD.id;
END;
INSERT OR IGNORE INTO imap_messages(address_id, folder, mail_id) SELECT a.id, 'INBOX', m.id FROM raw_mails m JOIN address a ON a.name = m.address ORDER BY m.id;
INSERT OR IGNORE INTO imap_messages(address_id, folder, mail_id) SELECT a.id, 'SENT', m.id FROM sendbox m JOIN address a ON a.name = m.address ORDER BY m.id;
INSERT INTO settings(key, value) VALUES ('db_version', 'v0.0.7') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
