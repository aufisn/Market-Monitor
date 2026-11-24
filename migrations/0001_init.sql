-- Market Monitor: initial D1 schema (FR-4.9, FR-4.10, FR-4.11, FR-5.8, FR-8.10, FR-11.2, FR-2.5).
-- Backward compatible by design (FR-14.3): later migrations only ADD tables/columns.
-- Design rules: every query below is served by a primary key or an index; JSON
-- columns hold whole objects so one run writes few rows; times are UTC epoch ms.

-- Settings: a single row (id = 1), JSON of the Settings object.
CREATE TABLE IF NOT EXISTS settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  json        TEXT    NOT NULL,
  updated_ms  INTEGER NOT NULL
);

-- Watchlist: one row per stock, JSON of StockConfig. "enabled" is kept as a column for filtering.
CREATE TABLE IF NOT EXISTS stocks (
  symbol      TEXT    PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  json        TEXT    NOT NULL,
  updated_ms  INTEGER NOT NULL
) WITHOUT ROWID;

-- Run lock (FR-4.11): one row per lease name; expires_ms makes a crashed run self-heal.
CREATE TABLE IF NOT EXISTS leases (
  name        TEXT    PRIMARY KEY,
  holder      TEXT    NOT NULL,
  expires_ms  INTEGER NOT NULL
) WITHOUT ROWID;

-- Latest market facts per stock per trading date (JSON of MarketState).
CREATE TABLE IF NOT EXISTS market_state (
  date        TEXT    NOT NULL,
  symbol      TEXT    NOT NULL,
  json        TEXT    NOT NULL,
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (date, symbol)
) WITHOUT ROWID;

-- Volume baselines (FR-6): one row per symbol (latest build only).
CREATE TABLE IF NOT EXISTS baselines (
  symbol      TEXT    PRIMARY KEY,
  built_for   TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  json        TEXT    NOT NULL
) WITHOUT ROWID;

-- Alert state machine, one row per (date, symbol, rule); "version" is the optimistic-lock counter.
CREATE TABLE IF NOT EXISTS rule_state (
  date        TEXT    NOT NULL,
  symbol      TEXT    NOT NULL,
  rule        TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  json        TEXT    NOT NULL,
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (date, symbol, rule)
) WITHOUT ROWID;

-- De-duplication of alerts (FR-4.10): INSERT OR IGNORE, changes() tells who won.
CREATE TABLE IF NOT EXISTS alert_ids (
  date        TEXT    NOT NULL,
  symbol      TEXT    NOT NULL,
  rule        TEXT    NOT NULL,
  cycle       INTEGER NOT NULL,
  created_ms  INTEGER NOT NULL,
  PRIMARY KEY (date, symbol, rule, cycle)
) WITHOUT ROWID;

-- Small key/value bookkeeping (last successful poll, last Telegram update id, notice timestamps ...).
CREATE TABLE IF NOT EXISTS run_meta (
  k           TEXT    PRIMARY KEY,
  v           TEXT    NOT NULL,
  updated_ms  INTEGER NOT NULL
) WITHOUT ROWID;

-- Outbound Telegram queue (FR-5.4, FR-5.8). Lower priority number sends first.
CREATE TABLE IF NOT EXISTS outbound_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  priority    INTEGER NOT NULL,
  created_ms  INTEGER NOT NULL,
  sent_ms     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  event       TEXT    NOT NULL
);
-- Partial index: only unsent rows, in send order. Keeps the "what is waiting" query to a few rows.
CREATE INDEX IF NOT EXISTS idx_outbound_pending ON outbound_queue (priority, id) WHERE sent_ms IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_sent    ON outbound_queue (sent_ms) WHERE sent_ms IS NOT NULL;

-- Event log (FR-11). Purged after 90 days.
CREATE TABLE IF NOT EXISTS log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  t_ms        INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  symbol      TEXT,
  rule        TEXT,
  detail      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_t        ON log (t_ms);
CREATE INDEX IF NOT EXISTS idx_log_symbol_t ON log (symbol, t_ms) WHERE symbol IS NOT NULL;

-- Daily budget counters (FR-10.4).
CREATE TABLE IF NOT EXISTS counters (
  date        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, name)
) WITHOUT ROWID;

-- Configuration change log with previous value (FR-2.5).
CREATE TABLE IF NOT EXISTS config_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  t_ms        INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  prev        TEXT,
  next        TEXT
);
CREATE INDEX IF NOT EXISTS idx_config_log_t ON config_log (t_ms);

-- Dashboard login throttling (FR-8.10). "client" is a hash, never a raw address.
CREATE TABLE IF NOT EXISTS auth_failures (
  client          TEXT    PRIMARY KEY,
  fails           INTEGER NOT NULL,
  window_start_ms INTEGER NOT NULL,
  locked_until_ms INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
