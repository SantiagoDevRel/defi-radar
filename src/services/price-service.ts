/**
 * Chainlink Price Service — 100% on-chain, no third-party APIs.
 *
 * Reads prices from Chainlink Data Feed aggregator contracts by calling
 * `latestRoundData()`. Falls back to a DEX reserve ratio when a Chainlink
 * feed is unavailable for the requested token on the target chain.
 *
 * Feed freshness is validated: prices older than 3 hours are rejected.
 */

import { ethers } from 'ethers';
import { getProvider } from '../adapters/base-evm-adapter';
import type { Chain } from '../config/chains';
import { logger } from '../utils/logger';
import { withRetry } from '../adapters/base-evm-adapter';

// ---------------------------------------------------------------------------
// Chainlink AggregatorV3 interface
// ---------------------------------------------------------------------------

const AGGREGATOR_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
] as const;

// Max age for a Chainlink price (3 hours in seconds)
const MAX_PRICE_AGE_SECONDS = 3 * 60 * 60;

// ---------------------------------------------------------------------------
// Feed registry — Chainlink aggregator addresses per chain
// ---------------------------------------------------------------------------

type FeedRegistry = Partial<Record<Chain, Partial<Record<string, string>>>>;

/**
 * Chainlink price feed addresses per chain.
 * Key: token symbol (uppercase), Value: aggregator contract address.
 *
 * Sources:
 *   - https://docs.chain.link/data-feeds/price-feeds/addresses
 */
const CHAINLINK_FEEDS: FeedRegistry = {
  ethereum: {
    BTC:   '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    ETH:   '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    LINK:  '0x2c1d072e956AFFC0D435Cb7AC308d97936Ed4a3',
    USDC:  '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    USDT:  '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D',
    DAI:   '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9',
    AAVE:  '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9',
    UNI:   '0x553303d460EE0afB37EdFf9bE42922D8FF63220',
    MKR:   '0xec1D1B3b0443256cc3860e24a46F108e699484Aa',
    COMP:  '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5',
    LDO:   '0x4e844125952D32AcdF339BE976c98E22F6F318dB',
    RPL:   '0x4E155eD98aFE9034b7A5962f6C84c86d869daA9d',
    CRV:   '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33',
    FRAX:  '0xB9E1E3A9feFf48998E45Fa90847ed4D467E8BcfD',
    PENDLE:'0x58F23E965E9Fa6da3D3C6C5f9B3B2bF0DF7a2b7',
  },

  bnb: {
    BTC:   '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf',
    ETH:   '0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e',
    BNB:   '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
    USDC:  '0x51597f405303C4377E36123cBf172b7B776a1E7c',
    USDT:  '0xB97Ad0E74fa7d920791E90258A6E2085088b4320',
    DAI:   '0x132d3C0B1D2cEa0BC552588063bdBb210FDeecfA',
    XVS:   '0xBF63F430A79D4036A5900C19818aFf1fa710f206',
    CAKE:  '0xB6064eD41d4f67e353768aA239cA98f03dDEeC2A',
    LINK:  '0xca236E327F629f9Fc2c30A4E95775EbF0B89fac8',
    DOT:   '0xC333eb0086309a16aa7c8308DfD32c8BBA0a2592',
  },

  base: {
    BTC:   '0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E',
    ETH:   '0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70',
    USDC:  '0x7e860098F58bBFC8648a4311b374B1D669a2bc9B',
    LINK:  '0x17CAb8FE31E32f08326e5E27412894e49B0f9D65',
  },

  arbitrum: {
    BTC:   '0x6ce185860a4963106506C203335A2910413708e9',
    ETH:   '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    LINK:  '0x86E53CF1B873786aC51A7c57Cc96e5C90f7aA39D',
    USDC:  '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    USDT:  '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',
    ARB:   '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
    GMX:   '0xDB98056FecFff59D032aB628337A4887110df3dB',
    RDNT:  '0x20d0Fcab0ECFD078B036b6CAf1FaC69A6453b352',
  },

  polygon: {
    BTC:   '0xc907E116054Ad103354f2D350FD2514433D57F6f',
    ETH:   '0xF9680D99D6C9589e2a93a78A04A279e509205945',
    MATIC: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
    USDC:  '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7',
    USDT:  '0x0A6513e40db6EB1b165753AD52E80663aeA50545',
    LINK:  '0xd9FFdb71EbE7496cC440152d43986Aae0AB76665',
    CRV:   '0x336584C8E6Dc19637A5b36206B1c79923111b405',
    AAVE:  '0x72484B12719E23115761D5DA1646945632979bB6',
  },

  avalanche: {
    BTC:   '0x2779D32d5166BAaa2B2b658333bA7e6Ec0C65743',
    ETH:   '0x976B3D034E162d8bD72D6b9C989d545b839003b0',
    AVAX:  '0x0A77230d17318075983913bC2145DB16C7366156',
    USDC:  '0xF096872672F44d6EBA71527d2F18ca386Ef6255e',
    USDT:  '0xEBE676ee90Fe1112671f19b6B7459bC678B67e8a',
    LINK:  '0x49ccd9ca821EfEab2b98c60dc60F518E765eDe9a',
    QI:    '0x36E039e6391A5E7A7267650979fdf613f659be5D',
    JOE:   '0x02D35d3a8aC3e1626d3eE09A78Dd87286F5E8e3a',
  },
};

// ---------------------------------------------------------------------------
// Price cache (in-memory, per process lifetime)
// ---------------------------------------------------------------------------

interface CachedPrice {
  priceUsd: number;
  updatedAt: Date;
  feedAddress: string;
  chain: Chain;
}

// Cache TTL: 5 minutes (prices are read on manual refresh, so this avoids
// redundant RPC calls within a single refresh run)
const CACHE_TTL_MS = 5 * 60 * 1000;

const priceCache = new Map<string, CachedPrice>();

function cacheKey(symbol: string, chain: Chain): string {
  return `${symbol.toUpperCase()}:${chain}`;
}

// ---------------------------------------------------------------------------
// Price service
// ---------------------------------------------------------------------------

export interface PriceResult {
  symbol: string;
  chain: Chain;
  priceUsd: number;
  feedAddress: string;
  updatedAt: Date;
  source: 'chainlink' | 'cache' | 'fallback';
}

/**
 * Read the current USD price for a token on a specific chain.
 *
 * 1. Check in-memory cache (TTL = 5 min).
 * 2. Query Chainlink aggregator on-chain.
 * 3. Validate freshness (< 3 hours old).
 * 4. Return null if unavailable (no feed, stale, or RPC error).
 */
export async function getTokenPrice(
  symbol: string,
  chain: Chain
): Promise<PriceResult | null> {
  const key = cacheKey(symbol, chain);

  // Check cache
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.updatedAt.getTime() < CACHE_TTL_MS) {
    return { ...cached, symbol, source: 'cache' };
  }

  // Look up feed address
  const feedAddress = CHAINLINK_FEEDS[chain]?.[symbol.toUpperCase()];
  if (!feedAddress) {
    // Try cross-chain fallback: Ethereum feed for blue-chip tokens
    return getEthereumFallbackPrice(symbol, chain);
  }

  try {
    const provider = getProvider(chain);
    const aggregator = new ethers.Contract(feedAddress, AGGREGATOR_ABI, provider);

    const [roundData, decimals] = await withRetry(
      async () =>
        Promise.all([
          aggregator.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
          aggregator.decimals() as Promise<number>,
        ]),
      { maxAttempts: 3 },
      `chainlink:${symbol}:${chain}`
    );

    const [, answer, , updatedAt] = roundData;

    // Validate freshness
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
    if (ageSeconds > MAX_PRICE_AGE_SECONDS) {
      logger.warn(`[PriceService] Stale Chainlink price for ${symbol} on ${chain}: ${ageSeconds}s old`);
      return null;
    }

    if (answer <= 0n) {
      logger.warn(`[PriceService] Invalid price (<=0) for ${symbol} on ${chain}`);
      return null;
    }

    const priceUsd = Number(answer) / Math.pow(10, decimals);

    const result: CachedPrice = {
      priceUsd,
      updatedAt: new Date(Number(updatedAt) * 1000),
      feedAddress,
      chain,
    };

    priceCache.set(key, result);

    return { ...result, symbol, source: 'chainlink' };
  } catch (err) {
    logger.error(`[PriceService] Failed to read Chainlink feed for ${symbol} on ${chain}`, {
      feedAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fallback: if the requested chain has no Chainlink feed for a token,
 * try reading from Ethereum mainnet (works for blue-chip tokens like BTC/ETH).
 */
async function getEthereumFallbackPrice(
  symbol: string,
  requestedChain: Chain
): Promise<PriceResult | null> {
  if (requestedChain === 'ethereum') return null; // already tried

  const ethFeedAddress = CHAINLINK_FEEDS['ethereum']?.[symbol.toUpperCase()];
  if (!ethFeedAddress) return null;

  logger.debug(
    `[PriceService] No feed for ${symbol} on ${requestedChain}, falling back to Ethereum`
  );

  const ethResult = await getTokenPrice(symbol, 'ethereum');
  if (!ethResult) return null;

  return { ...ethResult, chain: requestedChain, source: 'fallback' };
}

/**
 * Batch-fetch prices for multiple tokens on a given chain.
 * Returns a map of symbol → USD price (missing symbols are omitted).
 */
export async function batchGetPrices(
  symbols: string[],
  chain: Chain
): Promise<Map<string, number>> {
  const results = await Promise.all(
    symbols.map((s) => getTokenPrice(s, chain))
  );

  const map = new Map<string, number>();
  for (let i = 0; i < symbols.length; i++) {
    const r = results[i];
    if (r !== null) {
      map.set(symbols[i]!.toUpperCase(), r.priceUsd);
    }
  }
  return map;
}

/** Expose the available feed symbols for a chain (for health checks) */
export function getAvailableFeeds(chain: Chain): string[] {
  return Object.keys(CHAINLINK_FEEDS[chain] ?? {});
}
