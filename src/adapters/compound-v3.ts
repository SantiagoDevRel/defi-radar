/**
 * Compound V3 (Comet) Adapter — multi-chain
 *
 * Chains: Ethereum, Arbitrum, Polygon, Base
 *
 * Each Comet instance is a single-asset lending market (USDC or ETH).
 * Supply APY is read directly from the Comet contract.
 *
 * Data sources (all on-chain):
 *   Comet.getUtilization()                  → current utilization (1e18 = 100%)
 *   Comet.getSupplyRate(utilization)        → per-second supply rate (1e18)
 *   Comet.totalSupply()                     → total supplied (base token decimals)
 *   Comet.baseToken()                       → ERC20 address of base asset
 *   Comet.baseTokenPriceFeed()              → Chainlink price feed for base asset
 *   Comet.baseTrackingSupplySpeed()         → COMP rewards per second (scaled)
 *   Comet.trackingIndexScale()              → scale factor for tracking speed
 *   CometRewards.rewardConfig(comet)        → reward token address
 *   Chainlink feed for COMP price
 *
 * APY formula (supply):
 *   ratePerSecond = getSupplyRate(getUtilization()) / 1e18
 *   APY = (1 + ratePerSecond)^SECONDS_PER_YEAR − 1   (compound interest)
 *
 * Reward APY:
 *   compPerSecond = baseTrackingSupplySpeed / trackingIndexScale / 1e18
 *   rewardAPY = compPerSecond * SECONDS_PER_YEAR * COMP_price / TVL_USD * 100
 *
 * Contracts verified on block explorers:
 *   https://docs.compound.finance/
 */

import { ethers } from 'ethers';
import { getProvider, withRetry, AGGREGATOR_V3_ABI, ERC20_ABI } from './base-evm-adapter';
import type { ProtocolAdapter, YieldPool } from './types';
import type { Chain } from '../config/chains';
import { isTokenAllowed } from '../config/whitelist';
import { calculateRiskScore } from '../services/risk-calculator';
import { generatePoolId } from '../utils/format';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const COMET_ABI = [
  'function getSupplyRate(uint256 utilization) external view returns (uint64)',
  'function getUtilization() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function baseToken() external view returns (address)',
  'function baseTokenPriceFeed() external view returns (address)',
  'function baseTrackingSupplySpeed() external view returns (uint64)',
  'function trackingIndexScale() external view returns (uint64)',
  'function decimals() external view returns (uint8)',
] as const;

const COMET_REWARDS_ABI = [
  'function rewardConfig(address comet) external view returns (address token, uint64 rescaleFactor, bool shouldUpscale)',
] as const;

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

interface CometMarket {
  chain: Chain;
  cometAddress: string;
  rewardsAddress: string;
  /** Human-readable label for logging */
  label: string;
  /** Chainlink COMP/USD price feed on this chain */
  compPriceFeed?: string;
}

const COMET_MARKETS: CometMarket[] = [
  // Ethereum
  {
    chain: 'ethereum',
    cometAddress:   '0xc3d688b66703497daa19211eedff47f25384cdc3', // cUSDCv3
    rewardsAddress: '0x1b0e765f6224c21223aea2af16c1cf0e57ac3ef4',
    label: 'USDC',
    compPriceFeed:  '0xdbd020caef83efde6d1ef148c99c8f37ae7c469', // COMP/USD on Ethereum
  },
  {
    chain: 'ethereum',
    cometAddress:   '0xa17581a9e3356d9a858b789d68b4d866e593ae94', // cWETHv3
    rewardsAddress: '0x1b0e765f6224c21223aea2af16c1cf0e57ac3ef4',
    label: 'WETH',
    compPriceFeed:  '0xdbd020caef83efde6d1ef148c99c8f37ae7c469',
  },
  // Arbitrum
  {
    chain: 'arbitrum',
    cometAddress:   '0xa5edbdd9646f8dff606d7448e414884c7d905dca', // cUSDCev3
    rewardsAddress: '0x88730d254a2f7e6ac8388c3198afd694ba9f7fae',
    label: 'USDC.e',
    compPriceFeed:  '0xe7c53ffd03eb6cef7d208bc4c520440e5a0c1d3e', // COMP/USD on Arbitrum
  },
  // Polygon
  {
    chain: 'polygon',
    cometAddress:   '0xf25212e676d1f7f89cd72ffee66158f541246445', // cUSDCv3
    rewardsAddress: '0x45939657d1ca34a8fa39a924b71d28fe8431e581',
    label: 'USDC',
    compPriceFeed:  undefined, // no reliable Chainlink COMP feed on Polygon
  },
  // Base
  {
    chain: 'base',
    cometAddress:   '0xb125e6687d4313864e53df431d5425969c15eb2f', // cUSDbCv3
    rewardsAddress: '0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1',
    label: 'USDbC',
    compPriceFeed:  undefined,
  },
];

const SECONDS_PER_YEAR = 31_536_000;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CompoundV3Adapter implements ProtocolAdapter {
  readonly name = 'compound';
  readonly chains: readonly Chain[] = ['ethereum', 'arbitrum', 'polygon', 'base'];

  async fetchPools(): Promise<YieldPool[]> {
    logger.info('[Compound V3] Starting multi-chain fetch');

    // Per-market timeout: 45s. Prevents one slow chain from blocking the whole adapter.
    const MARKET_TIMEOUT_MS = 45_000;

    const results = await Promise.allSettled(
      COMET_MARKETS.map((m) =>
        Promise.race([
          this.fetchMarket(m),
          new Promise<YieldPool | null>((_, reject) =>
            setTimeout(() => reject(new Error(`Market ${m.chain}/${m.label} timed out`)), MARKET_TIMEOUT_MS)
          ),
        ])
      )
    );

    const pools: YieldPool[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        pools.push(result.value);
      } else if (result.status === 'rejected') {
        logger.error('[Compound V3] Market fetch failed', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    logger.info(`[Compound V3] Total pools fetched: ${pools.length}`);
    return pools;
  }

  private async fetchMarket(market: CometMarket): Promise<YieldPool | null> {
    const provider = getProvider(market.chain);
    const comet = new ethers.Contract(market.cometAddress, COMET_ABI, provider);

    // Read all market data in parallel
    const [
      utilization,
      baseTokenAddress,
      priceFeedAddress,
      totalSupply,
      decimals,
      baseTrackingSupplySpeed,
      trackingIndexScale,
    ] = await Promise.all([
      withRetry(() => comet.getUtilization(), {}, `compound/${market.chain}/getUtilization`) as Promise<bigint>,
      withRetry(() => comet.baseToken(), {}, `compound/${market.chain}/baseToken`) as Promise<string>,
      withRetry(() => comet.baseTokenPriceFeed(), {}, `compound/${market.chain}/priceFeed`) as Promise<string>,
      withRetry(() => comet.totalSupply(), {}, `compound/${market.chain}/totalSupply`) as Promise<bigint>,
      withRetry(() => comet.decimals(), {}, `compound/${market.chain}/decimals`) as Promise<bigint>,
      withRetry(() => comet.baseTrackingSupplySpeed(), {}, `compound/${market.chain}/trackingSpeed`).catch(() => 0n) as Promise<bigint>,
      withRetry(() => comet.trackingIndexScale(), {}, `compound/${market.chain}/trackingScale`).catch(() => BigInt(1e15)) as Promise<bigint>,
    ]);

    // Supply rate at current utilization
    const supplyRateRaw: bigint = await withRetry(
      () => comet.getSupplyRate(utilization),
      {},
      `compound/${market.chain}/getSupplyRate`
    );

    // APY from per-second rate
    const ratePerSecond = Number(supplyRateRaw) / 1e18;
    const apyBase = (Math.pow(1 + ratePerSecond, SECONDS_PER_YEAR) - 1) * 100;

    // Base token price from Chainlink price feed
    const chainlinkFeed = new ethers.Contract(priceFeedAddress, AGGREGATOR_V3_ABI, provider);
    const [, priceAnswer] = await withRetry(
      () => chainlinkFeed.latestRoundData(),
      {},
      `compound/${market.chain}/price`
    ) as readonly [unknown, bigint, ...unknown[]];

    const baseTokenDecimals = Number(decimals);
    // Chainlink feeds return 8-decimal prices
    const baseTokenPrice = Number(priceAnswer) / 1e8;

    if (baseTokenPrice <= 0) return null;

    const tvlUsd = (Number(totalSupply) / 10 ** baseTokenDecimals) * baseTokenPrice;
    if (tvlUsd < 100_000) return null;

    // Get base token symbol for whitelist check
    const baseErc20 = new ethers.Contract(baseTokenAddress, ERC20_ABI, provider);
    const rawSymbol: string = await withRetry(
      () => baseErc20.symbol(),
      {},
      `compound/${market.chain}/symbol`
    );
    const tokenSymbol = rawSymbol.toUpperCase()
      .replace('USDBC', 'USDC')
      .replace('USDC.E', 'USDC');

    if (!isTokenAllowed(tokenSymbol, tvlUsd)) return null;

    // COMP reward APY
    let apyReward = 0;
    try {
      apyReward = await this.getCompRewardApy(
        market,
        baseTrackingSupplySpeed,
        trackingIndexScale,
        tvlUsd,
        provider
      );
    } catch (err) {
      logger.debug(`[Compound V3][${market.chain}] Reward APY unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    const apyTotal = apyBase + apyReward;

    const riskScore = calculateRiskScore({
      protocolId: 'compound',
      tvlUsd,
      apyBase,
      apyReward,
      yieldType: 'lending',
    });

    return {
      id: generatePoolId('compound', market.chain, market.cometAddress),
      protocol: 'compound',
      protocolDisplay: 'Compound V3',
      chain: market.chain,
      type: 'lending',
      tokens: [tokenSymbol],
      apyBase,
      apyReward,
      apyTotal,
      tvlUsd,
      riskScore,
      il7d: null,
      url: `https://app.compound.finance/?market=${market.label}`,
      contractAddress: market.cometAddress,
      lastUpdated: new Date(),
    };
  }

  private async getCompRewardApy(
    market: CometMarket,
    baseTrackingSupplySpeed: bigint,
    trackingIndexScale: bigint,
    tvlUsd: number,
    provider: ethers.JsonRpcProvider
  ): Promise<number> {
    if (baseTrackingSupplySpeed === 0n || tvlUsd <= 0) return 0;

    // COMP per second for all suppliers:
    // compPerSecond = baseTrackingSupplySpeed / trackingIndexScale (in COMP 1e18 units)
    const scale = Number(trackingIndexScale) > 0 ? Number(trackingIndexScale) : 1e15;
    const compPerSecondRaw = Number(baseTrackingSupplySpeed) / scale;
    const compPerSecondHuman = compPerSecondRaw / 1e18;

    if (compPerSecondHuman <= 0) return 0;

    // Get COMP price
    let compPriceUsd = 0;

    if (market.compPriceFeed) {
      try {
        const feed = new ethers.Contract(market.compPriceFeed, AGGREGATOR_V3_ABI, provider);
        const [, answer] = await withRetry(
          () => feed.latestRoundData(),
          { maxAttempts: 2 },
          `compound/${market.chain}/compPrice`
        ) as readonly [unknown, bigint, ...unknown[]];
        compPriceUsd = Number(answer) / 1e8;
      } catch { /* skip */ }
    }

    if (compPriceUsd <= 0) {
      // Try to get COMP price from CometRewards config + fallback Chainlink
      try {
        const rewards = new ethers.Contract(market.rewardsAddress, COMET_REWARDS_ABI, provider);
        const config = await withRetry(
          () => rewards.rewardConfig(market.cometAddress),
          { maxAttempts: 2 },
          `compound/${market.chain}/rewardConfig`
        ) as { token: string };

        if (config.token && config.token !== ethers.ZeroAddress) {
          // We have the reward token address but no price — skip rewards
          logger.debug(`[Compound V3][${market.chain}] COMP price unavailable, skipping rewards`);
        }
      } catch { /* skip */ }
      return 0;
    }

    const annualCompUsd = compPerSecondHuman * SECONDS_PER_YEAR * compPriceUsd;
    return (annualCompUsd / tvlUsd) * 100;
  }
}
