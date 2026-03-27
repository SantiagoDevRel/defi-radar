/**
 * Risk Calculator — assigns a 1–10 risk score to each yield pool.
 *
 * Five equally-weighted factors (each 0–4 points, but capped at 10 total):
 *
 * 1. Protocol age:      >3yr = 0, 1-3yr = 1-2, <1yr = 3-4
 * 2. Audit status:      Top firm = 0, known firm = 1-2, no audit = 3-4
 * 3. TVL:               >$100M = 0, $10-100M = 1-2, <$10M = 3-4
 * 4. APY composition:   100% base = 0, mixed = 1-2, 100% rewards = 3-4
 * 5. IL exposure:       None = 0, moderate = 1-2, high = 3-4
 *
 * Final score = clamp(sum, 1, 10)
 *
 * Interpretation:
 *   1–3  = Safe (green)
 *   4–6  = Moderate (yellow)
 *   7–10 = High risk (red)
 */

import { getProtocolMeta } from '../config/protocols.js';
import type { YieldType } from '../adapters/types.js';

// ---------------------------------------------------------------------------
// Input to the risk calculator
// ---------------------------------------------------------------------------

export interface RiskInput {
  protocolId: string;
  tvlUsd: number;
  apyBase: number;
  apyReward: number;
  yieldType: YieldType;
  /** Optional: override impermanent loss score directly (0–4) */
  ilScoreOverride?: number;
}

// ---------------------------------------------------------------------------
// Factor scores
// ---------------------------------------------------------------------------

function scoreProtocolAge(launchDate: string | undefined): number {
  if (!launchDate) return 2; // unknown → moderate

  const launchMs = new Date(launchDate).getTime();
  const ageYears = (Date.now() - launchMs) / (1000 * 60 * 60 * 24 * 365.25);

  if (ageYears > 3) return 0;
  if (ageYears > 2) return 1;
  if (ageYears > 1) return 2;
  if (ageYears > 0.5) return 3;
  return 4;
}

function scoreAuditStatus(
  auditStatus: 'top-firm' | 'known-firm' | 'no-audit' | undefined
): number {
  switch (auditStatus) {
    case 'top-firm':   return 0;
    case 'known-firm': return 1;
    case 'no-audit':   return 4;
    default:           return 2; // unknown
  }
}

function scoreTvl(tvlUsd: number): number {
  if (tvlUsd > 100_000_000) return 0; // > $100M
  if (tvlUsd > 50_000_000)  return 1; // $50-100M
  if (tvlUsd > 10_000_000)  return 2; // $10-50M
  if (tvlUsd > 1_000_000)   return 3; // $1-10M
  return 4;                            // < $1M
}

function scoreApyComposition(apyBase: number, apyReward: number): number {
  const total = apyBase + apyReward;
  if (total === 0) return 0;

  const rewardFraction = apyReward / total;

  if (rewardFraction === 0)    return 0; // 100% base
  if (rewardFraction < 0.25)   return 1; // mostly base
  if (rewardFraction < 0.75)   return 2; // mixed
  if (rewardFraction < 1.0)    return 3; // mostly rewards
  return 4;                               // 100% rewards (ponzinomic risk)
}

function scoreIl(yieldType: YieldType, ilScoreOverride?: number): number {
  if (ilScoreOverride !== undefined) return ilScoreOverride;

  switch (yieldType) {
    case 'lending':      return 0; // no IL
    case 'staking':      return 0; // no IL
    case 'stable-farm':  return 1; // pegged pair — minimal IL
    case 'vault':        return 1; // managed, low IL
    case 'lp':           return 3; // standard CLAMM LP — significant IL risk
    default:             return 2;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Calculate a risk score (1–10) for a yield pool.
 *
 * @param input - Protocol and pool metadata
 * @returns integer risk score in [1, 10]
 */
export function calculateRiskScore(input: RiskInput): number {
  const meta = getProtocolMeta(input.protocolId);

  const ageScore    = scoreProtocolAge(meta?.launchDate);
  const auditScore  = scoreAuditStatus(meta?.auditStatus);
  const tvlScore    = scoreTvl(input.tvlUsd);
  const apyScore    = scoreApyComposition(input.apyBase, input.apyReward);
  const ilScore     = scoreIl(input.yieldType, input.ilScoreOverride);

  const raw = ageScore + auditScore + tvlScore + apyScore + ilScore;

  // Scale: max raw = 4+4+4+4+4 = 20 → map to 1–10
  // score = round(raw / 20 * 9) + 1  (gives range 1..10)
  const scaled = Math.round((raw / 20) * 9) + 1;

  return Math.max(1, Math.min(10, scaled));
}

/**
 * Return a human-readable risk label for a score.
 */
export function riskLabel(score: number): 'safe' | 'moderate' | 'high' {
  if (score <= 3) return 'safe';
  if (score <= 6) return 'moderate';
  return 'high';
}

/**
 * Return the factor breakdown for debugging / UI tooltip.
 */
export function getRiskBreakdown(input: RiskInput): {
  ageScore: number;
  auditScore: number;
  tvlScore: number;
  apyScore: number;
  ilScore: number;
  total: number;
  label: 'safe' | 'moderate' | 'high';
} {
  const meta = getProtocolMeta(input.protocolId);

  const ageScore    = scoreProtocolAge(meta?.launchDate);
  const auditScore  = scoreAuditStatus(meta?.auditStatus);
  const tvlScore    = scoreTvl(input.tvlUsd);
  const apyScore    = scoreApyComposition(input.apyBase, input.apyReward);
  const ilScore     = scoreIl(input.yieldType, input.ilScoreOverride);

  const raw = ageScore + auditScore + tvlScore + apyScore + ilScore;
  const total = Math.max(1, Math.min(10, Math.round((raw / 20) * 9) + 1));

  return { ageScore, auditScore, tvlScore, apyScore, ilScore, total, label: riskLabel(total) };
}
