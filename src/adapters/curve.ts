/**
 * Curve Finance Adapter — stablecoin pools
 *
 * Chains: Ethereum, Arbitrum, Polygon
 * Focus: stablecoin pools (USDC-USDT, DAI-USDC-USDT / 3pool) which have low IL.
 *
 * Data sources (all on-chain):
 *   Pool.get_virtual_price()   → LP token value in USD (1e18)
 *   Pool.balances(i)           → per-token reserves
 *   Pool.coins(i)              → token addresses
 *   Gauge.inflation_rate()     → CRV per second (1e18) [older gauges]
 *   Gauge.totalSupply()        → total LP staked in gauge
 *   Gauge.reward_data(crv)     → CRV emission rate [newer gauges]
 *   Chainlink CRV/USD feed     → CRV price
 *
 * Base APY method:
 *   Query virtual_price at current block and at a block ~7 days ago.
 *   Annualize the growth rate:
 *     apy = (currentVP / historicalVP − 1) × (365/7) × 100
 *   This captures fee revenue that has compounded into the LP token.
 *
 * Reward APY:
 *   crvPerSecond = inflation_rate() [or rate from reward_data()]
 *   stakedLpUsd = gauge.totalSupply() / 1e18 × pool virtual_price
 *   rewardApy = crvPerSecond × SECONDS_PER_YEAR × CRV_price / stakedLpUsd × 100
 *
 * Contracts verified on block explorers.
 */

import { ethers } from 'ethers';
import { getProvider, withRetry, AGGREGATOR_V3_ABI } from './base-evm-adapter';
import type { ProtocolAdapter, YieldPool } from './types';
import type { Chain } from '../config/chains';
import { calculateRiskScore } from '../services/risk-calculator';
import { generatePoolId } from '../utils/format';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const CURVE_POOL_ABI = [
  'function get_virtual_price() external view returns (uint256)',
  'function balances(uint256 i) external view returns (uint256)',
  'function coins(uint256 i) external view returns (address)',
  'function fee() external view returns (uint256)',              // in 1e10
  'function totalSupply() external view returns (uint256)',
] as const;

/** Older Curve gauges (pre-factory) */
const CURVE_GAUGE_ABI_OLD = [
  'function inflation_rate() external view returns (uint256)',   // CRV/second
  'function totalSupply() external view returns (uint256)',      // total LP staked
  'function working_supply() external view returns (uint256)',
] as const;

/** Newer factory gauges */
const CURVE_GAUGE_ABI_NEW = [
  'function totalSupply() external view returns (uint256)',
  'function reward_count() external view returns (uint256)',
  'function reward_tokens(uint256 i) external view returns (address)',
  'function reward_data(address token) external view returns (address distributor, uint256 period_finish, uint256 rate, uint256 last_update, uint256 integral)',
] as const;

// ---------------------------------------------------------------------------
// Pool config
// ---------------------------------------------------------------------------

interface CurvePool {
  chain: Chain;
  poolAddress: string;
  gaugeAddress: string;
  tokens: string[];  // human-readable symbols
  label: string;
  gaugeType: 'old' | 'new';
  /** blocks per day on this chain (for historical VP query) */
  blocksPerDay: number;
}

const CURVE_POOLS: CurvePool[] = [
  // Ethereum — 3pool (DAI/USDC/USDT)
  {
    chain: 'ethereum',
    poolAddress:  '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    gaugeAddress: '0xbfcf63294ad7105dea65aa58f8ae5be2d9d0952a',
    tokens: ['DAI', 'USDC', 'USDT'],
    label: '3pool',
    gaugeType: 'old',
    blocksPerDay: 7200,   // ~12s blocks
  },
  // Ethereum — FRAX/USDC
  {
    chain: 'ethereum',
    poolAddress:  '0xdcef968d416a41cdac0ed8702fac8128a64241a2',
    gaugeAddress: '0xcfc25170633581bf896cb6cdee170e3e3aa59503',
    tokens: ['FRAX', 'USDC'],
    label: 'FRAX-USDC',
    gaugeType: 'old',
    blocksPerDay: 7200,
  },
  // Arbitrum — 2pool (USDC.e/USDT)
  {
    chain: 'arbitrum',
    poolAddress:  '0x7f90122bf0700f9e7e1f688fe926940e8839f353',
    gaugeAddress: '0xce5f24b7a95e9cba7df4b54e911b4a3dc8cdaf6f',
    tokens: ['USDC', 'USDT'],
    label: '2pool',
    gaugeType: 'new',
    blocksPerDay: 86400,  // ~1s blocks on Arbitrum
  },
  // Polygon — aave pool (aDAI/aUSDC/aUSDT)
  {
    chain: 'polygon',
    poolAddress:  '0x445fe580ef8d70ff569ab36e898906d9892cf3b4',
    gaugeAddress: '0x19793b454d3afc7b454f206ffe95ade26ca6912c',
    tokens: ['DAI', 'USDC', 'USDT'],
    label: 'aave-pool',
    gaugeType: 'old',
    blocksPerDay: 43200,  // ~2s blocks on Polygon
  },
];

/** Chainlink CRV/USD feeds per chain */
const CRV_USD_FEEDS: Partial<Record<Chain, string>> = {
  ethereum: '0xcd627aa160a6fa45eb793d19ef54f5062f20f33f',
  arbitrum: '0xaebda2c976cfd1ee1977eac079b4382acb849325',
  polygon:  '0x336584c8e6dc19637a5b36206b1c79923111b405',
};

const SECONDS_PER_YEAR = 31_536_000;
const DAYS_FOR_APY     = 7;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CurveAdapter implements ProtocolAdapter {
  readonly name = 'curve';
  readonly chains: readonly Chain[] = ['ethereum', 'arbitrum', 'polygon'];

  async fetchPools(): Promise<YieldPool[]> {
    logger.info('[Curve] Starting multi-chain fetch');

    // Per-pool timeout: 40s. Prevents Ethereum historical queries from blocking other chains.
    const POOL_TIMEOUT_MS = 40_000;

    const results = await Promise.allSettled(
      CURVE_POOLS.map((p) =>
        Promise.race([
          this.fetchPool(p),
          new Promise<YieldPool | null>((_, reject) =>
            setTimeout(() => reject(new Error(`Pool ${p.chain}/${p.label} timed out`)), POOL_TIMEOUT_MS)
          ),
        ])
      )
    );

    const pools: YieldPool[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        pools.push(result.value);
      } else if (result.status === 'rejected') {
        logger.error('[Curve] Pool fetch failed', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    logger.info(`[Curve] Total pools fetched: ${pools.length}`);
    return pools;
  }

  private async fetchPool(poolCfg: CurvePool): Promise<YieldPool | null> {
    const provider = getProvider(poolCfg.chain);
    const pool = new ethers.Contract(poolCfg.poolAddress, CURVE_POOL_ABI, provider);

    // Get current virtual price
    const currentVP: bigint = await withRetry(
      () => pool.get_virtual_price(),
      {},
      `curve/${poolCfg.chain}/${poolCfg.label}/get_virtual_price`
    );

    // Get historical virtual price ~7 days ago for fee APY calculation
    const apyBase = await this.calcFeeApy(pool, poolCfg, provider, currentVP);

    // Total LP supply in USD (TVL proxy)
    const lpTotalSupply: bigint = await withRetry(
      () => pool.totalSupply(),
      {},
      `curve/${poolCfg.chain}/${poolCfg.label}/totalSupply`
    ).catch(() => 0n);

    // TVL = lpSupply (in 1e18 LP tokens) * virtual_price (in 1e18 USD per LP)
    // virtual_price is already in USD (1 LP ≈ $1 for stable pools at launch, grows over time)
    const tvlUsd = (Number(lpTotalSupply) / 1e18) * (Number(currentVP) / 1e18);

    if (tvlUsd < 100_000) {
      logger.debug(`[Curve][${poolCfg.chain}] ${poolCfg.label}: TVL too low ($${tvlUsd.toFixed(0)})`);
      return null;
    }

    // CRV reward APY
    const crvPriceUsd = await this.getCrvPrice(poolCfg.chain, provider);
    const apyReward = await this.calcRewardApy(poolCfg, provider, tvlUsd, crvPriceUsd, currentVP);

    const apyTotal = apyBase + apyReward;

    logger.info(
      `[Curve][${poolCfg.chain}] ${poolCfg.label}: base=${apyBase.toFixed(2)}% reward=${apyReward.toFixed(2)}% TVL=$${(tvlUsd / 1e6).toFixed(1)}M`
    );

    const riskScore = calculateRiskScore({
      protocolId: 'curve',
      tvlUsd,
      apyBase,
      apyReward,
      yieldType: 'stable-farm',
      ilScoreOverride: 1, // stable pool — very low IL
    });

    return {
      id: generatePoolId('curve', poolCfg.chain, poolCfg.poolAddress),
      protocol: 'curve',
      protocolDisplay: 'Curve Finance',
      chain: poolCfg.chain,
      type: 'stable-farm',
      tokens: poolCfg.tokens,
      apyBase,
      apyReward,
      apyTotal,
      tvlUsd,
      riskScore,
      il7d: 0, // stablecoin pools — effectively zero IL
      url: `https://curve.fi/#/${poolCfg.chain}/pools`,
      contractAddress: poolCfg.poolAddress,
      lastUpdated: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // Fee APY from virtual price change
  // ---------------------------------------------------------------------------

  private async calcFeeApy(
    pool: ethers.Contract,
    poolCfg: CurvePool,
    provider: ethers.JsonRpcProvider,
    currentVP: bigint
  ): Promise<number> {
    try {
      const currentBlock = await provider.getBlockNumber();
      const historicalBlock = currentBlock - poolCfg.blocksPerDay * DAYS_FOR_APY;
      if (historicalBlock <= 0) return 0;

      // Use low-level provider.call to query virtual_price at a historical block
      const iface = new ethers.Interface(['function get_virtual_price() view returns (uint256)']);
      const callData = iface.encodeFunctionData('get_virtual_price');

      // ethers v6: pass blockTag inside the transaction object (not as a second arg)
      const rawResult = await withRetry(
        () => provider.call({ to: poolCfg.poolAddress, data: callData, blockTag: historicalBlock }),
        { maxAttempts: 2 },
        `curve/${poolCfg.chain}/${poolCfg.label}/historical_vp`
      );

      const decoded = iface.decodeFunctionResult('get_virtual_price', rawResult);
      const historicalVP = decoded[0] as bigint;

      if (historicalVP === 0n) return 0;

      // Annualize: (currentVP / historicalVP - 1) * (365 / DAYS_FOR_APY)
      const apy = (Number(currentVP) / Number(historicalVP) - 1) * (365 / DAYS_FOR_APY) * 100;
      return Math.max(0, apy);
    } catch (err) {
      logger.debug(
        `[Curve][${poolCfg.chain}] ${poolCfg.label} fee APY unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // CRV reward APY
  // ---------------------------------------------------------------------------

  private async calcRewardApy(
    poolCfg: CurvePool,
    provider: ethers.JsonRpcProvider,
    totalPoolTvlUsd: number,
    crvPriceUsd: number,
    currentVP: bigint
  ): Promise<number> {
    if (crvPriceUsd <= 0) return 0;

    try {
      if (poolCfg.gaugeType === 'old') {
        return this.calcOldGaugeRewards(poolCfg, provider, totalPoolTvlUsd, crvPriceUsd, currentVP);
      } else {
        return this.calcNewGaugeRewards(poolCfg, provider, totalPoolTvlUsd, crvPriceUsd, currentVP);
      }
    } catch (err) {
      logger.debug(
        `[Curve][${poolCfg.chain}] ${poolCfg.label} reward APY unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
      return 0;
    }
  }

  private async calcOldGaugeRewards(
    poolCfg: CurvePool,
    provider: ethers.JsonRpcProvider,
    totalPoolTvlUsd: number,
    crvPriceUsd: number,
    currentVP: bigint
  ): Promise<number> {
    const gauge = new ethers.Contract(poolCfg.gaugeAddress, CURVE_GAUGE_ABI_OLD, provider);

    const [inflationRate, gaugeTotalSupply]: [bigint, bigint] = await Promise.all([
      withRetry(() => gauge.inflation_rate(), { maxAttempts: 2 }, `curve/inflation:${poolCfg.label}`),
      withRetry(() => gauge.totalSupply(), { maxAttempts: 2 }, `curve/gaugeTotalSupply:${poolCfg.label}`),
    ]);

    if (inflationRate === 0n || gaugeTotalSupply === 0n) return 0;

    // Staked TVL = gauge LP supply * virtual_price (USD per LP)
    const stakedTvlUsd = (Number(gaugeTotalSupply) / 1e18) * (Number(currentVP) / 1e18);
    if (stakedTvlUsd <= 0) return 0;

    const crvPerSecond = Number(inflationRate) / 1e18;
    const annualCrvUsd = crvPerSecond * SECONDS_PER_YEAR * crvPriceUsd;
    return (annualCrvUsd / stakedTvlUsd) * 100;
  }

  private async calcNewGaugeRewards(
    poolCfg: CurvePool,
    provider: ethers.JsonRpcProvider,
    _totalPoolTvlUsd: number,
    crvPriceUsd: number,
    currentVP: bigint
  ): Promise<number> {
    const gauge = new ethers.Contract(poolCfg.gaugeAddress, CURVE_GAUGE_ABI_NEW, provider);

    const [rewardCount, gaugeTotalSupply]: [bigint, bigint] = await Promise.all([
      withRetry(() => gauge.reward_count(), { maxAttempts: 2 }, `curve/rewardCount:${poolCfg.label}`).catch(() => 0n),
      withRetry(() => gauge.totalSupply(), { maxAttempts: 2 }, `curve/gaugeTotalSupply:${poolCfg.label}`),
    ]);

    if (rewardCount === 0n || gaugeTotalSupply === 0n) return 0;

    const stakedTvlUsd = (Number(gaugeTotalSupply) / 1e18) * (Number(currentVP) / 1e18);
    if (stakedTvlUsd <= 0) return 0;

    const nowTs = Math.floor(Date.now() / 1000);
    let totalRewardApy = 0;

    for (let i = 0; i < Number(rewardCount); i++) {
      try {
        const tokenAddr: string = await withRetry(
          () => gauge.reward_tokens(i),
          { maxAttempts: 2 },
          `curve/rewardToken:${i}`
        );
        const rewardData = await withRetry(
          () => gauge.reward_data(tokenAddr),
          { maxAttempts: 2 },
          `curve/rewardData:${i}`
        ) as { period_finish: bigint; rate: bigint };

        if (Number(rewardData.period_finish) < nowTs) continue;
        if (rewardData.rate === 0n) continue;

        // Assume all reward tokens in these pools are CRV
        const ratePerSecond = Number(rewardData.rate) / 1e18;
        const annualRewardUsd = ratePerSecond * SECONDS_PER_YEAR * crvPriceUsd;
        totalRewardApy += (annualRewardUsd / stakedTvlUsd) * 100;
      } catch { continue; }
    }

    return totalRewardApy;
  }

  // ---------------------------------------------------------------------------
  // CRV price from Chainlink
  // ---------------------------------------------------------------------------

  private async getCrvPrice(chain: Chain, provider: ethers.JsonRpcProvider): Promise<number> {
    const feedAddress = CRV_USD_FEEDS[chain];
    if (!feedAddress) return 0;

    try {
      const feed = new ethers.Contract(feedAddress, AGGREGATOR_V3_ABI, provider);
      const [, answer] = await withRetry(
        () => feed.latestRoundData(),
        { maxAttempts: 2 },
        `curve/${chain}/crvPrice`
      ) as readonly [unknown, bigint, ...unknown[]];
      return Number(answer) / 1e8;
    } catch {
      return 0;
    }
  }
}
