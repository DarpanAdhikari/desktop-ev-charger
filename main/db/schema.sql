-- VoltDesk local schema. Everything lands here first; sync_queue is the outbox
-- the background worker drains toward the backend server.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS shifts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,          -- e.g. "Day", "Night"
  start_time      TEXT NOT NULL,          -- "HH:MM", 24h local
  end_time        TEXT NOT NULL,          -- "HH:MM"; may wrap past midnight
  rate_per_kwh    REAL NOT NULL,
  tax_applicable  INTEGER NOT NULL DEFAULT 0,  -- 0/1
  tax_percent     REAL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS chargers (
  id          TEXT PRIMARY KEY,   -- charger_id from OCPP
  vendor      TEXT,
  model       TEXT,
  first_seen  TEXT,
  last_seen   TEXT,
  online      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS connectors (
  charger_id    TEXT NOT NULL,
  connector_id  INTEGER NOT NULL,
  status        TEXT,
  error_code    TEXT,
  updated_at    TEXT,
  PRIMARY KEY (charger_id, connector_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  charger_id      TEXT NOT NULL,
  connector_id    INTEGER NOT NULL,
  ocpp_tx_id      INTEGER,
  started_at      TEXT,
  stopped_at      TEXT,
  duration_sec    INTEGER,
  energy_kwh      REAL,
  soc_start       INTEGER,
  soc_end         INTEGER,
  status          TEXT NOT NULL DEFAULT 'active', -- active | stopped | disconnected
  synced          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bills (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id    INTEGER NOT NULL REFERENCES transactions(id),
  bill_number       TEXT UNIQUE NOT NULL,   -- prefix + running number
  company_name      TEXT,
  shift_id          INTEGER REFERENCES shifts(id),
  rate_per_kwh      REAL,
  energy_kwh        REAL,
  subtotal          REAL,
  tax_percent       REAL DEFAULT 0,
  tax_amount        REAL DEFAULT 0,
  service_fee       REAL DEFAULT 0,
  service_charge    REAL DEFAULT 0,
  soc_start         INTEGER,
  soc_end           INTEGER,
  rate_name         TEXT,
  total             REAL,
  print_success_count INTEGER NOT NULL DEFAULT 0,
  print_fail_count    INTEGER NOT NULL DEFAULT 0,
  synced            INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  charger_id  TEXT,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL   -- raw JSON, as pushed by the CSMS
);

-- Generic outbox: one row per thing that needs to reach the backend.
CREATE TABLE IF NOT EXISTS sync_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL,     -- 'bill' | 'log' | 'transaction'
  entity_id     INTEGER NOT NULL,
  endpoint_key  TEXT NOT NULL,     -- maps to a configured endpoint in settings
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_charger ON logs(charger_id, ts);
CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_tx_charger ON transactions(charger_id, connector_id);
