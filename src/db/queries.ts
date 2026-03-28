/**
 * Typed database queries for DeFi Radar (sql.js backend).
 *
 * sql.js uses a slightly different API from better-sqlite3:
 *   - db.run(sql, params)       — execute without returning rows
 *   - db.exec(sql)              — execute and return [{columns, values}]
 *   - db.prepare(sql)           — returns a Statement
 *   - stmt.bind(params)
 *   - stmt.step()               — advance cursor, returns true if row available
 *   - stmt.getAsObject(params?) — return current row as {col: value}
 *   - stmt.free()               — release memory
 *
 * For simplicity, helper functions below wrap this into a familiar API.
 */

import { getDb, persistDb, runRetentionCleanup } from './database';
import type { YieldPool } from '../adapters/types';
import type { Chain } from '../config/chains';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Low-level query helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type SqlParams = (string | number | null)[];

/** Execute a query and return all matching rows */
function queryAll(sql: string, params: SqlParams = []): Row[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: Row[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Row);
  }
  stmt.free();
  return rows;
}

/** Execute a query and return the first matching row, or undefined */
function queryOne(sql: string, params: SqlParams = []): Row | undefined {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row: Row | undefined;
  if (stmt.step()) {
    row = stmt.getAsObject() as Row;
  }
  stmt.free();
  return row;
}

/** Execute a write statement and return lastInsertRowid */
function execute(sql: string, params: SqlParams = []): number {
  const db = getDb();
  db.run(sql, params);
  // Get last insert rowid
  const result = queryOne('SELECT last_insert_rowid() as id');
  return (result?.['id'] as number) ?? 0;
}

// ---------------------------------------------------------------------------
// Row ↔ YieldPool conversion
// ---------------------------------------------------------------------------

interface PoolRow {
  id: string;
  protocol: string;
  protocol_display: string;
  chain: string;
  type: string;
  tokens: string;
  apy_base: number;
  apy_reward: number;
  apy_total: number;
  tvl_usd: number;
  risk_score: number;
  il_7d: number | null;
  url: string;
  contract_address: string;
  last_updated: string;
}

function rowToYieldPool(row: Row): YieldPool {
  const r = row as unknown as PoolRow;
  return {
    id: r.id,
    protocol: r.protocol,
    protocolDisplay: r.protocol_display,
    chain: r.chain as Chain,
    type: r.type as YieldPool['type'],
    tokens: JSON.parse(r.tokens) as string[],
    apyBase: r.apy_base,
    apyReward: r.apy_reward,
    apyTotal: r.apy_total,
    tvlUsd: r.tvl_usd,
    riskScore: r.risk_score,
    il7d: r.il_7d,
    url: r.url,
    contractAddress: r.contract_address,
    lastUpdated: new Date(r.last_updated),
  };
}

// ---------------------------------------------------------------------------
// Write queries
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of pools and write a history snapshot.
 * Wrapped in a BEGIN/COMMIT transaction for atomicity + performance.
 */
export function saveSnapshot(pools: YieldPool[]): void {
  const db = getDb();
  const snapshotTime = new Date().toISOString();

  db.run('BEGIN');
  try {
    for (const pool of pools) {
      // Upsert pool
      db.run(
        `INSERT INTO pools (
          id, protocol, protocol_display, chain, type, tokens,
          apy_base, apy_reward, apy_total, tvl_usd, risk_score,
          il_7d, url, contract_address, last_updated
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          protocol         = excluded.protocol,
          protocol_display = excluded.protocol_display,
          chain            = excluded.chain,
          type             = excluded.type,
          tokens           = excluded.tokens,
          apy_base         = excluded.apy_base,
          apy_reward       = excluded.apy_reward,
          apy_total        = excluded.apy_total,
          tvl_usd          = excluded.tvl_usd,
          risk_score       = excluded.risk_score,
          il_7d            = excluded.il_7d,
          url              = excluded.url,
          contract_address = excluded.contract_address,
          last_updated     = excluded.last_updated`,
        [
          pool.id,
          pool.protocol,
          pool.protocolDisplay,
          pool.chain,
          pool.type,
          JSON.stringify(pool.tokens),
          pool.apyBase,
          pool.apyReward,
          pool.apyTotal,
          pool.tvlUsd,
          pool.riskScore,
          pool.il7d ?? null,
          pool.url,
          pool.contractAddress,
          pool.lastUpdated.toISOString(),
        ]
      );

      // Insert history snapshot
      db.run(
        `INSERT INTO pool_history (pool_id, snapshot_time, apy_base, apy_reward, apy_total, tvl_usd, risk_score)
         VALUES (?,?,?,?,?,?,?)`,
        [pool.id, snapshotTime, pool.apyBase, pool.apyReward, pool.apyTotal, pool.tvlUsd, pool.riskScore]
      );
    }

    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }

  persistDb();
  logger.info(`[DB] Saved snapshot: ${pools.length} pools`);
  runRetentionCleanup();
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

export function getAllPools(): YieldPool[] {
  return queryAll('SELECT * FROM pools ORDER BY apy_total DESC').map(rowToYieldPool);
}

export function getPoolsByChain(chain: Chain): YieldPool[] {
  return queryAll('SELECT * FROM pools WHERE chain = ? ORDER BY apy_total DESC', [chain]).map(rowToYieldPool);
}

export function getPoolsByToken(symbol: string): YieldPool[] {
  return queryAll(
    `SELECT * FROM pools WHERE tokens LIKE ? ORDER BY apy_total DESC`,
    [`%"${symbol.toUpperCase()}"%`]
  ).map(rowToYieldPool);
}

export function getPoolsByProtocol(protocolId: string): YieldPool[] {
  return queryAll('SELECT * FROM pools WHERE protocol = ? ORDER BY apy_total DESC', [protocolId]).map(rowToYieldPool);
}

export function getPoolById(id: string): YieldPool | null {
  const row = queryOne('SELECT * FROM pools WHERE id = ?', [id]);
  return row ? rowToYieldPool(row) : null;
}

// ---------------------------------------------------------------------------
// History queries
// ---------------------------------------------------------------------------

export interface HistoryPoint {
  snapshotTime: Date;
  apyTotal: number;
  tvlUsd: number;
}

export function getPoolHistory(poolId: string, days = 30): HistoryPoint[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const rows = queryAll(
    `SELECT snapshot_time, apy_total, tvl_usd
     FROM pool_history
     WHERE pool_id = ? AND snapshot_time >= ?
     ORDER BY snapshot_time ASC`,
    [poolId, cutoff.toISOString()]
  );

  return rows.map((r) => ({
    snapshotTime: new Date(r['snapshot_time'] as string),
    apyTotal: r['apy_total'] as number,
    tvlUsd: r['tvl_usd'] as number,
  }));
}

// ---------------------------------------------------------------------------
// Refresh log
// ---------------------------------------------------------------------------

export function logRefreshStart(): number {
  return execute('INSERT INTO refresh_log (started_at) VALUES (?)', [new Date().toISOString()]);
}

export function logRefreshComplete(
  id: number,
  durationMs: number,
  poolCount: number,
  errorCount: number,
  error?: string
): void {
  execute(
    `UPDATE refresh_log SET completed_at=?, duration_ms=?, pool_count=?, error_count=?, error=? WHERE id=?`,
    [new Date().toISOString(), durationMs, poolCount, errorCount, error ?? null, id]
  );
  persistDb();
}

// ---------------------------------------------------------------------------
// DB stats
// ---------------------------------------------------------------------------

export function getDbStats(): {
  poolCount: number;
  historyRowCount: number;
  oldestSnapshot: string | null;
} {
  const poolRow = queryOne('SELECT COUNT(*) as n FROM pools');
  const histRow = queryOne('SELECT COUNT(*) as n FROM pool_history');
  const oldestRow = queryOne('SELECT MIN(snapshot_time) as t FROM pool_history');

  return {
    poolCount: (poolRow?.['n'] as number) ?? 0,
    historyRowCount: (histRow?.['n'] as number) ?? 0,
    oldestSnapshot: (oldestRow?.['t'] as string | null) ?? null,
  };
}
