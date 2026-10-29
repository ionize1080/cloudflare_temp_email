export const SMTP_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS smtp_submissions (\n    id TEXT PRIMARY KEY,\n    address_id INTEGER NOT NULL,\n    cost INTEGER NOT NULL CHECK(cost BETWEEN 1 AND 20),\n    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uncertain','sent','failed')),\n    claim TEXT NOT NULL,\n    lease INTEGER NOT NULL,\n    provider_id TEXT,\n    created_at INTEGER NOT NULL\n);",
  "CREATE TRIGGER IF NOT EXISTS smtp_reserve_quota AFTER INSERT ON smtp_submissions BEGIN\n    UPDATE address_sender SET balance = balance - NEW.cost\n    WHERE address = (SELECT name FROM address WHERE id = NEW.address_id) AND enabled = 1 AND balance >= NEW.cost;\n    SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'SMTP sending permission or quota unavailable') END;\nEND;",
  "CREATE TRIGGER IF NOT EXISTS smtp_refund_quota AFTER UPDATE OF state ON smtp_submissions\nWHEN NEW.state = 'failed' AND OLD.state IN ('pending','uncertain') BEGIN\n    UPDATE address_sender SET balance = balance + NEW.cost WHERE address = (SELECT name FROM address WHERE id = NEW.address_id);\nEND;",
  "CREATE TRIGGER IF NOT EXISTS smtp_address_delete AFTER DELETE ON address BEGIN\n    DELETE FROM smtp_submissions WHERE address_id = OLD.id;\nEND;",
  "INSERT INTO settings(key, value) VALUES ('db_version', 'v0.0.8') ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
];
