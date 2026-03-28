/**
 * Number formatting and ID generation helpers.
 */

import type { YieldPool } from '../adapters/types';
import type { Chain } from '../config/chains';
import { riskLabel } from '../services/risk-calculator';

// ---------------------------------------------------------------------------
// Pool ID
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic, globally unique pool ID.
 * Format: `{protocol}-{chain}-{contractAddress}`
 */
export function generatePoolId(
  protocol: string,
  chain: Chain,
  contractAddress: string
): string {
  return `${protocol}-${chain}-${contractAddress.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Format a USD value with appropriate suffix.
 * e.g. 1_500_000 → "$1.50M", 250_000 → "$250K"
 */
export function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000)     return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000)         return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

/**
 * Format an APY percentage with 2 decimal places.
 * e.g. 5.2345 → "5.23%"
 */
export function formatApy(apy: number): string {
  return `${apy.toFixed(2)}%`;
}

/**
 * Format a risk score with its label.
 * e.g. 3 → "3 (safe)"
 */
export function formatRisk(score: number): string {
  return `${score} (${riskLabel(score)})`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 1500 → "1.5s", 90000 → "1m 30s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs % 60}s`;
}

// ---------------------------------------------------------------------------
// YieldPool → API response shape
// ---------------------------------------------------------------------------

/**
 * Transform a YieldPool into the API response format.
 * Adds formatted strings alongside raw numbers for frontend convenience.
 */
export function formatYield(pool: YieldPool): Record<string, unknown> {
  const staleness = Date.now() - pool.lastUpdated.getTime();
  const staleHours = staleness / (1000 * 60 * 60);

  return {
    id:              pool.id,
    protocol:        pool.protocol,
    protocolDisplay: pool.protocolDisplay,
    chain:           pool.chain,
    type:            pool.type,
    tokens:          pool.tokens,

    // Raw numbers (for sorting / filtering in the frontend)
    apyBase:         pool.apyBase,
    apyReward:       pool.apyReward,
    apyTotal:        pool.apyTotal,
    tvlUsd:          pool.tvlUsd,
    riskScore:       pool.riskScore,
    il7d:            pool.il7d,

    // Formatted strings (for display)
    apyBaseFormatted:   formatApy(pool.apyBase),
    apyRewardFormatted: formatApy(pool.apyReward),
    apyTotalFormatted:  formatApy(pool.apyTotal),
    tvlFormatted:       formatUsd(pool.tvlUsd),
    riskLabel:          riskLabel(pool.riskScore),
    il7dFormatted:      pool.il7d !== null ? `${pool.il7d.toFixed(2)}%` : null,

    url:             pool.url,
    contractAddress: pool.contractAddress,
    lastUpdated:     pool.lastUpdated.toISOString(),

    // Staleness metadata for UI tinting
    staleHours:      parseFloat(staleHours.toFixed(2)),
    isStale:         staleHours > 6,
    isVeryStale:     staleHours > 24,
  };
}
