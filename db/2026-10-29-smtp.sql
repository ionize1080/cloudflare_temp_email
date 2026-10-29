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
