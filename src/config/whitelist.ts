/**
 * Token whitelist — 41 tokens organized into 4 tiers.
 *
 * Tier 1 — Blue chips: always shown regardless of TVL.
 * Tier 2 — Stablecoins: always shown, zero IL.
 * Tier 3 — DeFi protocols: shown only when pool TVL > $100M.
 * Tier 4 — Ecosystem / manual additions: shown when explicitly whitelisted.
 *
 * Blacklist: meme coins and tokens < 6 months old are never shown.
 */

export type TokenTier = 1 | 2 | 3 | 4;

export interface TokenEntry {
  symbol: string;
  tier: TokenTier;
  /** CoinGecko ID — kept for reference; prices are fetched on-chain via Chainlink */
  coingeckoId?: string;
  /** Minimum pool TVL in USD required to display (overrides per-tier default) */
  minTvlOverride?: number;
}

/** Minimum TVL thresholds per tier (USD) */
export const TIER_MIN_TVL: Record<TokenTier, number> = {
  1: 0,         // Blue chips: always show
  2: 0,         // Stablecoins: always show
  3: 100_000_000, // DeFi protocols: require $100M TVL
  4: 0,         // Ecosystem: show if whitelisted
};

// ---------------------------------------------------------------------------
// Tier 1 — Blue Chips
// ---------------------------------------------------------------------------
const TIER_1_TOKENS: TokenEntry[] = [
  { symbol: 'BTC',   tier: 1, coingeckoId: 'bitcoin' },
  { symbol: 'ETH',   tier: 1, coingeckoId: 'ethereum' },
  { symbol: 'BNB',   tier: 1, coingeckoId: 'binancecoin' },
  { symbol: 'SOL',   tier: 1, coingeckoId: 'solana' },
  { symbol: 'ADA',   tier: 1, coingeckoId: 'cardano' },
  { symbol: 'XLM',   tier: 1, coingeckoId: 'stellar' },
  { symbol: 'AVAX',  tier: 1, coingeckoId: 'avalanche-2' },
  { symbol: 'LINK',  tier: 1, coingeckoId: 'chainlink' },
  { symbol: 'DOT',   tier: 1, coingeckoId: 'polkadot' },
  { symbol: 'MATIC', tier: 1, coingeckoId: 'matic-network' },
];

// ---------------------------------------------------------------------------
// Tier 2 — Stablecoins
// ---------------------------------------------------------------------------
const TIER_2_TOKENS: TokenEntry[] = [
  { symbol: 'USDC',  tier: 2, coingeckoId: 'usd-coin' },
  { symbol: 'USDT',  tier: 2, coingeckoId: 'tether' },
  { symbol: 'DAI',   tier: 2, coingeckoId: 'dai' },
  { symbol: 'PYUSD', tier: 2, coingeckoId: 'paypal-usd' },
  { symbol: 'FRAX',  tier: 2, coingeckoId: 'frax' },
  { symbol: 'EURC',  tier: 2, coingeckoId: 'euro-coin' },
  { symbol: 'USDe',  tier: 2, coingeckoId: 'ethena-usde' },
];

// ---------------------------------------------------------------------------
// Tier 3 — DeFi Protocol Tokens (require pool TVL > $100M)
// ---------------------------------------------------------------------------
const TIER_3_TOKENS: TokenEntry[] = [
  { symbol: 'AAVE',   tier: 3, coingeckoId: 'aave' },
  { symbol: 'UNI',    tier: 3, coingeckoId: 'uniswap' },
  { symbol: 'CAKE',   tier: 3, coingeckoId: 'pancakeswap-token' },
  { symbol: 'CRV',    tier: 3, coingeckoId: 'curve-dao-token' },
  { symbol: 'LDO',    tier: 3, coingeckoId: 'lido-dao' },
  { symbol: 'MKR',    tier: 3, coingeckoId: 'maker' },
  { symbol: 'COMP',   tier: 3, coingeckoId: 'compound-governance-token' },
  { symbol: 'GMX',    tier: 3, coingeckoId: 'gmx' },
  { symbol: 'JOE',    tier: 3, coingeckoId: 'joe' },
  { symbol: 'BLND',   tier: 3, coingeckoId: 'blend' },
  { symbol: 'XVS',    tier: 3, coingeckoId: 'venus' },
  { symbol: 'QI',     tier: 3, coingeckoId: 'benqi' },
  { symbol: 'RPL',    tier: 3, coingeckoId: 'rocket-pool' },
];

// ---------------------------------------------------------------------------
// Tier 4 — Ecosystem + Manual additions
// ---------------------------------------------------------------------------
const TIER_4_TOKENS: TokenEntry[] = [
  { symbol: 'ARB',    tier: 4, coingeckoId: 'arbitrum' },
  { symbol: 'OP',     tier: 4, coingeckoId: 'optimism' },
  { symbol: 'SUI',    tier: 4, coingeckoId: 'sui' },
  { symbol: 'TON',    tier: 4, coingeckoId: 'the-open-network' },
  { symbol: 'STX',    tier: 4, coingeckoId: 'blockstack' },
  { symbol: 'NEAR',   tier: 4, coingeckoId: 'near' },
  { symbol: 'BIFI',   tier: 4, coingeckoId: 'beefy-finance' },
  { symbol: 'PENDLE', tier: 4, coingeckoId: 'pendle' },
  { symbol: 'MORPHO', tier: 4, coingeckoId: 'morpho' },
  { symbol: 'GNS',    tier: 4, coingeckoId: 'gains-network' },
  { symbol: 'RDNT',   tier: 4, coingeckoId: 'radiant-capital' },
];

// ---------------------------------------------------------------------------
// Blacklist — never show
// ---------------------------------------------------------------------------
export const BLACKLISTED_SYMBOLS = new Set<string>([
  'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', 'WIF', 'TRUMP',
]);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All whitelisted tokens flattened */
export const ALL_TOKENS: TokenEntry[] = [
  ...TIER_1_TOKENS,
  ...TIER_2_TOKENS,
  ...TIER_3_TOKENS,
  ...TIER_4_TOKENS,
];

/** Fast lookup: symbol → TokenEntry */
export const TOKEN_MAP = new Map<string, TokenEntry>(
  ALL_TOKENS.map((t) => [t.symbol.toUpperCase(), t])
);

/** All whitelisted symbols as a Set for O(1) membership tests */
export const WHITELISTED_SYMBOLS = new Set<string>(
  ALL_TOKENS.map((t) => t.symbol.toUpperCase())
);

/**
 * Determine whether a token symbol should be shown for a given pool TVL.
 */
export function isTokenAllowed(symbol: string, poolTvlUsd: number): boolean {
  const upper = symbol.toUpperCase();

  // Hard blacklist
  if (BLACKLISTED_SYMBOLS.has(upper)) return false;

  const entry = TOKEN_MAP.get(upper);
  if (!entry) return false; // not on whitelist

  const minTvl = entry.minTvlOverride ?? TIER_MIN_TVL[entry.tier];
  return poolTvlUsd >= minTvl;
}

export default ALL_TOKENS;
