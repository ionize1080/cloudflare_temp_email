CREATE TABLE IF NOT EXISTS auth_versions (
 kind TEXT NOT NULL, subject INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(kind,subject)
);
CREATE TABLE IF NOT EXISTS auth_challenges (
 nonce TEXT PRIMARY KEY, purpose TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry ON auth_challenges(expires_at);
CREATE TRIGGER IF NOT EXISTS revoke_mailbox_password AFTER UPDATE OF password ON address
WHEN OLD.password IS NOT NEW.password BEGIN
 INSERT INTO auth_versions(kind,subject,version) VALUES('mailbox',NEW.id,1)
 ON CONFLICT(kind,subject) DO UPDATE SET version=version+1;
 DELETE FROM imap_passwords WHERE address_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS revoke_user_password AFTER UPDATE OF password ON users
WHEN OLD.password IS NOT NEW.password BEGIN
 INSERT INTO auth_versions(kind,subject,version) VALUES('user',NEW.id,1)
 ON CONFLICT(kind,subject) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER IF NOT EXISTS revoke_deleted_user AFTER DELETE ON users BEGIN
 INSERT INTO auth_versions(kind,subject,version) VALUES('user',OLD.id,1)
 ON CONFLICT(kind,subject) DO UPDATE SET version=version+1;
 DELETE FROM users_address WHERE user_id=OLD.id;
 DELETE FROM user_roles WHERE user_id=OLD.id;
 DELETE FROM user_passkeys WHERE user_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS revoke_unbound_mailbox AFTER DELETE ON users_address BEGIN
 INSERT INTO auth_versions(kind,subject,version) VALUES('mailbox',OLD.address_id,1)
 ON CONFLICT(kind,subject) DO UPDATE SET version=version+1;
END;
INSERT INTO settings(key,value) VALUES('db_version','v0.0.10')
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP;
