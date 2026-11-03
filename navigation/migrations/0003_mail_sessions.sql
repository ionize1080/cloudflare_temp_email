ALTER TABLE nav_preferences ADD COLUMN mail_session_hours INTEGER NOT NULL DEFAULT 24;
CREATE TABLE IF NOT EXISTS nav_mail_tickets (
 token_hash TEXT PRIMARY KEY,
 session_hash TEXT NOT NULL REFERENCES nav_sessions(token_hash) ON DELETE CASCADE,
 address_id INTEGER NOT NULL REFERENCES address(id) ON DELETE CASCADE,
 password_version TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 mail_seconds INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nav_mail_ticket_expiry ON nav_mail_tickets(expires_at);
