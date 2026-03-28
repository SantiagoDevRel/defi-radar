/**
 * SQLite database setup via sql.js (pure WebAssembly — no native compilation).
 *
 * sql.js is synchronous after initialization, so the query layer stays sync.
 * We persist the database to disk manually after every write transaction
 * using fs.writeFileSync on the WASM memory buffer.
 *
 * Schema:
 *   pools         — latest snapshot of each yield pool (upserted on refresh)
 *   pool_history  — hourly historical records, retained for 90 days
 *   refresh_log   — diagnostic log for every refresh run
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module-level state (initialized once at startup via initDatabase())
// ---------------------------------------------------------------------------

let _db: Database | null = null;
let _dbPath: string = '';
let _SQL: SqlJsStatic | null = null;

// ---------------------------------------------------------------------------
// Initialization (must be called once before any query)
// ---------------------------------------------------------------------------

/**
 * Initialize the sql.js WASM engine and open (or create) the database file.
 * Call this from src/index.ts before starting the Express server.
 */
export async function initDatabase(): Promise<void> {
  _dbPath = path.resolve(process.env['DB_PATH'] ?? './data/defi-radar.db');

  // Ensure parent directory exists
  const dir = path.dirname(_dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load the WASM binary — sql.js bundles it inside the npm package
  _SQL = await initSqlJs();

  // Load existing DB from disk, or create a fresh one
  if (fs.existsSync(_dbPath)) {
    const fileBuffer = fs.readFileSync(_dbPath);
    _db = new _SQL.Database(fileBuffer);
    logger.info(`[DB] Loaded existing database from ${_dbPath}`);
  } else {
    _db = new _SQL.Database();
    logger.info(`[DB] Created new database at ${_dbPath}`);
  }

  runMigrations();
  logger.info('[DB] Migrations complete');
}

/**
 * Get the initialized database instance.
 * Throws if initDatabase() has not been called.
 */
export function getDb(): Database {
  if (!_db) {
    throw new Error('[DB] Database not initialized — call initDatabase() first');
  }
  return _db;
}

/**
 * Persist the in-memory WASM database to disk.
 * Called automatically after every write operation in queries.ts.
 */
export function persistDb(): void {
  if (!_db || !_dbPath) return;
  const data = _db.export();
  fs.writeFileSync(_dbPath, Buffer.from(data));
}

/** Gracefully close the database */
export function closeDb(): void {
  if (_db) {
    persistDb();
    _db.close();
    _db = null;
    logger.info('[DB] Database closed and persisted');
  }
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

function runMigrations(): void {
  const db = getDb();

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
      tokens           TEXT    NOT NULL,
      apy_base         REAL    NOT NULL,
      apy_reward       REAL    NOT NULL,
      apy_total        REAL    NOT NULL,
      tvl_usd          REAL    NOT NULL,
      risk_score       INTEGER NOT NULL,
      il_7d            REAL,
      url              TEXT    NOT NULL,
      contract_address TEXT    NOT NULL,
      last_updated     TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pools_chain    ON pools(chain);
    CREATE INDEX IF NOT EXISTS idx_pools_protocol ON pools(protocol);
    CREATE INDEX IF NOT EXISTS idx_pools_apy      ON pools(apy_total);

    -- -------------------------------------------------------------------------
    -- pool_history: hourly snapshots for trend data
    -- -------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS pool_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id       TEXT    NOT NULL,
      snapshot_time TEXT    NOT NULL,
      apy_base      REAL    NOT NULL,
      apy_reward    REAL    NOT NULL,
      apy_total     REAL    NOT NULL,
      tvl_usd       REAL    NOT NULL,
      risk_score    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_history_pool_time
      ON pool_history(pool_id, snapshot_time);

    -- -------------------------------------------------------------------------
    -- refresh_log
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
}

// ---------------------------------------------------------------------------
// Retention cleanup
// ---------------------------------------------------------------------------

export function runRetentionCleanup(): void {
  const db = getDb();
  const retentionDays = parseInt(process.env['DB_RETENTION_DAYS'] ?? '90', 10);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffIso = cutoff.toISOString();

  db.run('DELETE FROM pool_history WHERE snapshot_time < ?', [cutoffIso]);
  logger.debug(`[DB] Retention cleanup: removed history older than ${cutoffIso}`);
}
