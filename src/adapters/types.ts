/**
 * Core type definitions for DeFi Radar adapters.
 *
 * Every protocol adapter must implement the ProtocolAdapter interface.
 * Every yield opportunity is normalized into a YieldPool before storage/display.
 */

import type { Chain } from '../config/chains';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type YieldType = 'lending' | 'lp' | 'staking' | 'vault' | 'stable-farm';

/**
 * A normalized yield opportunity from any chain or protocol.
 *
 * APY fields are annualized percentages (e.g., 5.2 = 5.2%).
 * TVL and prices are always in USD.
 */
export interface YieldPool {
  /** Globally unique ID: `${protocol}-${chain}-${contractAddress}` */
  id: string;

  /** Protocol slug matching ProtocolMeta.id in protocols.ts */
  protocol: string;

  /** Display name of the protocol (e.g. "Venus Protocol") */
  protocolDisplay: string;

  chain: Chain;
  type: YieldType;

  /**
   * Token symbols involved in this pool.
   * Single-token pools (lending/staking): one entry.
   * LP pools: two entries [base, quote].
   */
  tokens: string[];

  /** Base APY from protocol fees / interest (does not include reward tokens) */
  apyBase: number;

  /** APY from emission reward tokens (can be 0) */
  apyReward: number;

  /** apyBase + apyReward */
  apyTotal: number;

  /** Total value locked in USD */
  tvlUsd: number;

  /** Risk score 1–10 (1=safe, 10=high risk) from risk-calculator.ts */
  riskScore: number;

  /**
   * 7-day impermanent loss estimate as a percentage (negative number means loss).
   * null for single-token pools where IL doesn't apply.
   */
  il7d: number | null;

  /** URL to the pool/market page on the protocol's app */
  url: string;

  /** Main contract address (vToken for lending, pool address for LP, etc.) */
  contractAddress: string;

  /** Timestamp of last successful on-chain data fetch */
  lastUpdated: Date;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Every protocol adapter must implement this interface.
 *
 * Adapters are responsible for:
 * 1. Reading raw data from the blockchain (no third-party APIs).
 * 2. Normalizing into YieldPool objects.
 * 3. Filtering by the token whitelist.
 * 4. Applying retry/error handling via BaseEvmAdapter or equivalent.
 */
export interface ProtocolAdapter {
  /** Unique slug matching ProtocolMeta.id */
  readonly name: string;

  /** Chains this adapter supports */
  readonly chains: readonly Chain[];

  /**
   * Fetch all yield pools for this protocol.
   * Returns empty array (not throws) on transient failures after retries.
   */
  fetchPools(): Promise<YieldPool[]>;
}

// ---------------------------------------------------------------------------
// Adapter result helpers
// ---------------------------------------------------------------------------

/** Result wrapper so the aggregator can attribute errors to adapters */
export interface AdapterResult {
  adapterName: string;
  pools: YieldPool[];
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Chainlink price feed types
// ---------------------------------------------------------------------------

export interface PriceFeed {
  /** Token symbol (e.g. "BTC") */
  symbol: string;
  /** Chainlink aggregator contract address */
  feedAddress: string;
  /** USD price */
  priceUsd: number;
  /** When this price was read */
  updatedAt: Date;
}
