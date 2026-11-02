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
