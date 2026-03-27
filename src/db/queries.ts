/**
 * Typed database queries for DeFi Radar.
 *
 * All queries are prepared statements (prevent SQL injection, improve perf).
 * better-sqlite3 is synchronous — no async/await needed for DB operations.
 */

import { getDb, runRetentionCleanup } from './database.js';
import type { YieldPool } from '../adapters/types.js';
import type { Chain } from '../config/chains.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Row ↔ YieldPool conversion
// ---------------------------------------------------------------------------

interface PoolRow {
  id: string;
  protocol: string;
  protocol_display: string;
  chain: string;
  type: string;
  tokens: string; // JSON
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

function poolRowToYieldPool(row: PoolRow): YieldPool {
  return {
    id: row.id,
    protocol: row.protocol,
    protocolDisplay: row.protocol_display,
    chain: row.chain as Chain,
    type: row.type as YieldPool['type'],
    tokens: JSON.parse(row.tokens) as string[],
    apyBase: row.apy_base,
    apyReward: row.apy_reward,
    apyTotal: row.apy_total,
    tvlUsd: row.tvl_usd,
    riskScore: row.risk_score,
    il7d: row.il_7d,
    url: row.url,
    contractAddress: row.contract_address,
    lastUpdated: new Date(row.last_updated),
  };
}

function yieldPoolToRow(pool: YieldPool): PoolRow {
  return {
    id: pool.id,
    protocol: pool.protocol,
    protocol_display: pool.protocolDisplay,
    chain: pool.chain,
    type: pool.type,
    tokens: JSON.stringify(pool.tokens),
    apy_base: pool.apyBase,
    apy_reward: pool.apyReward,
    apy_total: pool.apyTotal,
    tvl_usd: pool.tvlUsd,
    risk_score: pool.riskScore,
    il_7d: pool.il7d,
    url: pool.url,
    contract_address: pool.contractAddress,
    last_updated: pool.lastUpdated.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Write queries
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of pools and write a history snapshot.
 * Runs everything in a single transaction for atomicity.
 */
export function saveSnapshot(pools: YieldPool[]): void {
  const db = getDb();

  const upsertPool = db.prepare(`
    INSERT INTO pools (
      id, protocol, protocol_display, chain, type, tokens,
      apy_base, apy_reward, apy_total, tvl_usd, risk_score,
      il_7d, url, contract_address, last_updated
    ) VALUES (
      @id, @protocol, @protocol_display, @chain, @type, @tokens,
      @apy_base, @apy_reward, @apy_total, @tvl_usd, @risk_score,
      @il_7d, @url, @contract_address, @last_updated
    )
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
      last_updated     = excluded.last_updated
  `);

  const insertHistory = db.prepare(`
    INSERT INTO pool_history (pool_id, snapshot_time, apy_base, apy_reward, apy_total, tvl_usd, risk_score)
    VALUES (@pool_id, @snapshot_time, @apy_base, @apy_reward, @apy_total, @tvl_usd, @risk_score)
  `);

  const snapshotTime = new Date().toISOString();

  // Wrap in transaction
  const runAll = db.transaction((poolList: YieldPool[]) => {
    for (const pool of poolList) {
      const row = yieldPoolToRow(pool);
      upsertPool.run(row);

      insertHistory.run({
        pool_id: pool.id,
        snapshot_time: snapshotTime,
        apy_base: pool.apyBase,
        apy_reward: pool.apyReward,
        apy_total: pool.apyTotal,
        tvl_usd: pool.tvlUsd,
        risk_score: pool.riskScore,
      });
    }
  });

  runAll(pools);

  logger.info(`[DB] Saved snapshot: ${pools.length} pools`);

  // Run retention cleanup after every save (cheap operation)
  runRetentionCleanup();
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

/** Get all pools, sorted by APY descending */
export function getAllPools(): YieldPool[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM pools ORDER BY apy_total DESC')
    .all() as PoolRow[];
  return rows.map(poolRowToYieldPool);
}

/** Get pools filtered by chain */
export function getPoolsByChain(chain: Chain): YieldPool[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM pools WHERE chain = ? ORDER BY apy_total DESC')
    .all(chain) as PoolRow[];
  return rows.map(poolRowToYieldPool);
}

/** Get pools that contain a specific token symbol */
export function getPoolsByToken(symbol: string): YieldPool[] {
  const db = getDb();
  // tokens is stored as JSON array; use LIKE for a simple substring match
  const rows = db
    .prepare(
      `SELECT * FROM pools WHERE tokens LIKE ? ORDER BY apy_total DESC`
    )
    .all(`%"${symbol.toUpperCase()}"%`) as PoolRow[];
  return rows.map(poolRowToYieldPool);
}

/** Get pools filtered by protocol */
export function getPoolsByProtocol(protocolId: string): YieldPool[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM pools WHERE protocol = ? ORDER BY apy_total DESC')
    .all(protocolId) as PoolRow[];
  return rows.map(poolRowToYieldPool);
}

/** Get a single pool by ID */
export function getPoolById(id: string): YieldPool | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM pools WHERE id = ?')
    .get(id) as PoolRow | undefined;
  return row ? poolRowToYieldPool(row) : null;
}

// ---------------------------------------------------------------------------
// History queries
// ---------------------------------------------------------------------------

export interface HistoryPoint {
  snapshotTime: Date;
  apyTotal: number;
  tvlUsd: number;
}

/** Get APY history for a pool over the last N days */
export function getPoolHistory(
  poolId: string,
  days = 30
): HistoryPoint[] {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const rows = db
    .prepare(
      `SELECT snapshot_time, apy_total, tvl_usd
       FROM pool_history
       WHERE pool_id = ? AND snapshot_time >= ?
       ORDER BY snapshot_time ASC`
    )
    .all(poolId, cutoff.toISOString()) as Array<{
      snapshot_time: string;
      apy_total: number;
      tvl_usd: number;
    }>;

  return rows.map((r) => ({
    snapshotTime: new Date(r.snapshot_time),
    apyTotal: r.apy_total,
    tvlUsd: r.tvl_usd,
  }));
}

// ---------------------------------------------------------------------------
// Refresh log queries
// ---------------------------------------------------------------------------

export function logRefreshStart(): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO refresh_log (started_at) VALUES (?)`
    )
    .run(new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function logRefreshComplete(
  id: number,
  durationMs: number,
  poolCount: number,
  errorCount: number,
  error?: string
): void {
  const db = getDb();
  db.prepare(
    `UPDATE refresh_log
     SET completed_at = ?, duration_ms = ?, pool_count = ?, error_count = ?, error = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), durationMs, poolCount, errorCount, error ?? null, id);
}

/** DB stats for /api/health */
export function getDbStats(): {
  poolCount: number;
  historyRowCount: number;
  oldestSnapshot: string | null;
} {
  const db = getDb();

  const poolCount = (
    db.prepare('SELECT COUNT(*) as n FROM pools').get() as { n: number }
  ).n;

  const historyRowCount = (
    db.prepare('SELECT COUNT(*) as n FROM pool_history').get() as { n: number }
  ).n;

  const oldest = db
    .prepare('SELECT MIN(snapshot_time) as t FROM pool_history')
    .get() as { t: string | null };

  return {
    poolCount,
    historyRowCount,
    oldestSnapshot: oldest.t,
  };
}
