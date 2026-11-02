CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT,
    source TEXT,
    address TEXT,
    raw TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_raw_mails_address ON raw_mails(address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_created_at ON raw_mails(created_at);

CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);

CREATE TABLE IF NOT EXISTS address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    source_meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);

CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

CREATE INDEX IF NOT EXISTS idx_address_updated_at ON address(updated_at);

CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);

CREATE TABLE IF NOT EXISTS auto_reply_mails (
    id INTEGER PRIMARY KEY,
    source_prefix TEXT,
    name TEXT,
    address TEXT UNIQUE,
    subject TEXT,
    message TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_mails_address ON auto_reply_mails(address);

CREATE TABLE IF NOT EXISTS address_sender (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    requested_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_sender_address ON address_sender(address);

CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit(created_at);

CREATE TABLE IF NOT EXISTS sendbox (
    id INTEGER PRIMARY KEY,
    address TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);

CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    user_email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    user_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_user_email ON users(user_email);

CREATE TABLE IF NOT EXISTS users_address (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    address_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_address_user_id ON users_address(user_id);

CREATE INDEX IF NOT EXISTS idx_users_address_address_id ON users_address(address_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    role_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    passkey_name TEXT NOT NULL,
    passkey_id TEXT NOT NULL,
    passkey TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_user_id_passkey_id ON user_passkeys(user_id, passkey_id);

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

CREATE TABLE IF NOT EXISTS smtp_submissions (
    id TEXT PRIMARY KEY,
    address_id INTEGER NOT NULL,
    cost INTEGER NOT NULL CHECK(cost BETWEEN 1 AND 20),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uncertain','sent','failed')),
    claim TEXT NOT NULL,
    lease INTEGER NOT NULL,
    provider_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS smtp_reserve_quota AFTER INSERT ON smtp_submissions BEGIN
    UPDATE address_sender SET balance = balance - NEW.cost
    WHERE address = (SELECT name FROM address WHERE id = NEW.address_id) AND enabled = 1 AND balance >= NEW.cost;
    SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'SMTP sending permission or quota unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS smtp_refund_quota AFTER UPDATE OF state ON smtp_submissions
WHEN NEW.state = 'failed' AND OLD.state IN ('pending','uncertain') BEGIN
    UPDATE address_sender SET balance = balance + NEW.cost WHERE address = (SELECT name FROM address WHERE id = NEW.address_id);
END;
CREATE TRIGGER IF NOT EXISTS smtp_address_delete AFTER DELETE ON address BEGIN
    DELETE FROM smtp_submissions WHERE address_id = OLD.id;
END;
INSERT INTO settings(key, value) VALUES ('db_version', 'v0.0.8') ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- Public invitation registration and private attachment metadata.
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL, used_at INTEGER, used_by TEXT, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS invitation_redemptions (
  code_hash TEXT PRIMARY KEY REFERENCES invitations(code_hash), address TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS redeem_invitation BEFORE INSERT ON invitation_redemptions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM invitations WHERE code_hash=NEW.code_hash
    AND used_at IS NULL AND revoked_at IS NULL AND expires_at>unixepoch())
    THEN RAISE(ABORT, 'Invalid invitation') END;
  UPDATE invitations SET used_at=unixepoch(),used_by=NEW.address WHERE code_hash=NEW.code_hash;
END;
CREATE TABLE IF NOT EXISTS mail_attachments (
  id TEXT PRIMARY KEY, address_id INTEGER NOT NULL, filename TEXT NOT NULL,
  content_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 26214400),
  created_at INTEGER NOT NULL, expires_at INTEGER, ready INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS attachment_owner ON mail_attachments(address_id);
CREATE TRIGGER IF NOT EXISTS attachment_quota BEFORE INSERT ON mail_attachments BEGIN
 SELECT CASE WHEN (SELECT COALESCE(SUM(size),0) FROM mail_attachments WHERE address_id=NEW.address_id)+NEW.size>524288000
   OR (SELECT COUNT(*) FROM mail_attachments WHERE address_id=NEW.address_id AND expires_at IS NOT NULL)>=40
 THEN RAISE(ABORT, 'Attachment storage quota exceeded') END;
END;
CREATE TABLE IF NOT EXISTS web_submissions (
  id TEXT PRIMARY KEY, address_id INTEGER NOT NULL, digest TEXT NOT NULL, cost INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', claim TEXT NOT NULL, lease INTEGER NOT NULL,
  created_at INTEGER NOT NULL, provider_id TEXT
);
CREATE TRIGGER IF NOT EXISTS web_charge AFTER INSERT ON web_submissions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM address_sender s JOIN address a ON a.name=s.address
    WHERE a.id=NEW.address_id AND s.enabled=1 AND s.balance>=NEW.cost)
    THEN RAISE(ABORT, 'Sending permission or quota unavailable') END;
  UPDATE address_sender SET balance=balance-NEW.cost WHERE address=(SELECT name FROM address WHERE id=NEW.address_id);
END;
CREATE TRIGGER IF NOT EXISTS web_refund AFTER UPDATE OF state ON web_submissions
WHEN NEW.state='failed' AND OLD.state!='failed' BEGIN
  UPDATE address_sender SET balance=balance+NEW.cost WHERE address=(SELECT name FROM address WHERE id=NEW.address_id);
END;

CREATE TRIGGER IF NOT EXISTS public_mail_address_delete AFTER DELETE ON address BEGIN
 DELETE FROM web_submissions WHERE address_id=OLD.id;
 DELETE FROM invitation_redemptions WHERE address=OLD.name;
END;
INSERT INTO settings(key,value) VALUES('db_version','v0.0.9') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
