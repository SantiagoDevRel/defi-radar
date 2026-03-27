/**
 * SQLite database setup via better-sqlite3.
 *
 * Schema:
 *   pools         — latest snapshot of each yield pool (upserted on refresh)
 *   pool_history  — hourly historical records, retained for 90 days
 *
 * WAL mode is enabled for better read concurrency (multiple API reads during refresh).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = path.resolve(
    process.env['DB_PATH'] ?? './data/defi-radar.db'
  );

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);

  // Performance settings
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -32000'); // 32 MB
  _db.pragma('temp_store = MEMORY');
  _db.pragma('mmap_size = 268435456'); // 256 MB

  runMigrations(_db);

  logger.info(`[DB] Opened database at ${dbPath}`);
  return _db;
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

function runMigrations(db: Database.Database): void {
  db.exec(`
    -- -------------------------------------------------------------------------
    -- pools: latest state of each yield pool
    -- -------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS pools (
      id               TEXT    PRIMARY KEY,
      protocol         TEXT    NOT NULL,
      protocol_display TEXT    NOT NULL,
      chain            TEXT    NOT NULL,
      type             TEXT    NOT NULL,
      tokens           TEXT    NOT NULL,  -- JSON array
      apy_base         REAL    NOT NULL,
      apy_reward       REAL    NOT NULL,
      apy_total        REAL    NOT NULL,
      tvl_usd          REAL    NOT NULL,
      risk_score       INTEGER NOT NULL,
      il_7d            REAL,              -- nullable
      url              TEXT    NOT NULL,
      contract_address TEXT    NOT NULL,
      last_updated     TEXT    NOT NULL   -- ISO 8601
    );

    -- Indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_pools_chain    ON pools(chain);
    CREATE INDEX IF NOT EXISTS idx_pools_protocol ON pools(protocol);
    CREATE INDEX IF NOT EXISTS idx_pools_apy      ON pools(apy_total DESC);

    -- -------------------------------------------------------------------------
    -- pool_history: hourly snapshots for 90-day trend data
    -- -------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS pool_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id       TEXT    NOT NULL,
      snapshot_time TEXT    NOT NULL,  -- ISO 8601
      apy_base      REAL    NOT NULL,
      apy_reward    REAL    NOT NULL,
      apy_total     REAL    NOT NULL,
      tvl_usd       REAL    NOT NULL,
      risk_score    INTEGER NOT NULL,

      FOREIGN KEY (pool_id) REFERENCES pools(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_history_pool_time
      ON pool_history(pool_id, snapshot_time DESC);

    CREATE INDEX IF NOT EXISTS idx_history_time
      ON pool_history(snapshot_time DESC);

    -- -------------------------------------------------------------------------
    -- refresh_log: track every refresh run for diagnostics
    -- -------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS refresh_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT    NOT NULL,
      completed_at TEXT,
      duration_ms  INTEGER,
      pool_count   INTEGER,
      error_count  INTEGER,
      error        TEXT
    );
  `);

  logger.info('[DB] Migrations complete');
}

// ---------------------------------------------------------------------------
// Retention cleanup (call once per refresh cycle)
// ---------------------------------------------------------------------------

/**
 * Delete pool_history rows older than the configured retention period.
 * Runs inside a transaction for efficiency.
 */
export function runRetentionCleanup(): void {
  const db = getDb();
  const retentionDays = parseInt(
    process.env['DB_RETENTION_DAYS'] ?? '90',
    10
  );

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffIso = cutoff.toISOString();

  const stmt = db.prepare(
    'DELETE FROM pool_history WHERE snapshot_time < ?'
  );
  const info = stmt.run(cutoffIso);

  if (info.changes > 0) {
    logger.info(`[DB] Retention cleanup: removed ${info.changes} old history rows`);
  }
}

/** Gracefully close the database (call on process exit) */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info('[DB] Database closed');
  }
}
