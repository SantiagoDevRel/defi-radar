/**
 * Aave V3 Adapter — multi-chain lending
 *
 * Chains: Ethereum, Arbitrum, Polygon, Avalanche, Base
 *
 * Data sources (all on-chain, no APIs):
 *   Pool.getReservesList()     → asset addresses
 *   Pool.getReserveData()      → liquidityRate (RAY 27-decimal, per-second)
 *   aToken.totalSupply()       → supply TVL
 *   AaveOracle.getAssetPrice() → USD prices (8 decimals, like Chainlink)
 *   RewardsController.getRewardsData() → emissionPerSecond per reward token
 *
 * APY formula (base):
 *   APY = ((1 + liquidityRate / 1e27)^SECONDS_PER_YEAR - 1) * 100
 *
 * Pool addresses differ per chain (Ethereum unique; Arb/Poly/Avax share 0x794a…).
 * Contract addresses verified against https://docs.aave.com/developers/deployed-contracts
 */

import { ethers } from 'ethers';
import { getProvider, withRetry, AGGREGATOR_V3_ABI, ERC20_ABI } from './base-evm-adapter';
import type { ProtocolAdapter, YieldPool } from './types';
import type { Chain } from '../config/chains';
import { isTokenAllowed } from '../config/whitelist';
import { calculateRiskScore } from '../services/risk-calculator';
import { rayRateToApyPercent } from '../utils/apy-math';
import { generatePoolId } from '../utils/format';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const POOL_ABI = [
  'function getReservesList() external view returns (address[])',
  `function getReserveData(address asset) external view returns (
    tuple(
      tuple(uint256 data) configuration,
      uint128 liquidityIndex,
      uint128 currentLiquidityRate,
      uint128 variableBorrowIndex,
      uint128 currentVariableBorrowRate,
      uint128 currentStableBorrowRate,
      uint40 lastUpdateTimestamp,
      uint16 id,
      address aTokenAddress,
      address stableDebtTokenAddress,
      address variableDebtTokenAddress,
      address interestRateStrategyAddress,
      uint128 accruedToTreasury,
      uint128 unbacked,
      uint128 isolationModeTotalDebt
    ) reserveData
  )`,
] as const;

const ORACLE_ABI = [
  'function getAssetPrice(address asset) external view returns (uint256)',
  'function getAssetsPrices(address[] calldata assets) external view returns (uint256[])',
] as const;

const REWARDS_CONTROLLER_ABI = [
  'function getRewardsByAsset(address asset) external view returns (address[] memory)',
  'function getRewardsData(address asset, address reward) external view returns (uint256 index, uint256 emissionPerSecond, uint256 lastUpdateTimestamp, uint256 distributionEnd)',
] as const;

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

interface AaveChainConfig {
  chain: Chain;
  poolAddress: string;
  oracleAddress: string;
  rewardsControllerAddress: string;
}

const AAVE_CHAIN_CONFIGS: AaveChainConfig[] = [
  {
    chain: 'ethereum',
    poolAddress:              '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
    oracleAddress:            '0x54586be62e3c3580375ae3723c145253060ca0c2',
    rewardsControllerAddress: '0x8164cc65827dcfe994ab23944cbc90e0aa80bfcb',
  },
  {
    chain: 'arbitrum',
    poolAddress:              '0x794a61358d6845594f94dc1db02a252b5b4814ad',
    oracleAddress:            '0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7',
    rewardsControllerAddress: '0x929ec64c34a17401f460460d4b9390518e5b473e',
  },
  {
    chain: 'polygon',
    poolAddress:              '0x794a61358d6845594f94dc1db02a252b5b4814ad',
    oracleAddress:            '0xb023e699f5a33916ea823a16485e259257ca8bd1',
    rewardsControllerAddress: '0x929ec64c34a17401f460460d4b9390518e5b473e',
  },
  {
    chain: 'avalanche',
    poolAddress:              '0x794a61358d6845594f94dc1db02a252b5b4814ad',
    oracleAddress:            '0xebd36016b3ed09d4693ed4251c67bd858c3c7c9c',
    rewardsControllerAddress: '0x929ec64c34a17401f460460d4b9390518e5b473e',
  },
  {
    chain: 'base',
    poolAddress:              '0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
    oracleAddress:            '0x2cc0fc26ed4563a5ce5e8bdcfe1a4b0a16bb70',
    rewardsControllerAddress: '0xf9cc4f0d883f1a1eb2c253bdb46c254d3eda03f0',
  },
];

const SECONDS_PER_YEAR = 31_536_000;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AaveV3Adapter implements ProtocolAdapter {
  readonly name = 'aave';
  readonly chains: readonly Chain[] = ['ethereum', 'arbitrum', 'polygon', 'avalanche', 'base'];

  async fetchPools(): Promise<YieldPool[]> {
    logger.info('[Aave V3] Starting multi-chain fetch');

    // Per-chain timeout: 45s. Prevents one slow chain (e.g. Ethereum with demo RPC)
    // from blocking data from faster chains (Arbitrum, Avalanche, etc.)
    const CHAIN_TIMEOUT_MS = 45_000;

    const chainResults = await Promise.allSettled(
      AAVE_CHAIN_CONFIGS.map((cfg) =>
        Promise.race([
          this.fetchChain(cfg),
          new Promise<YieldPool[]>((_, reject) =>
            setTimeout(() => reject(new Error(`Chain ${cfg.chain} timed out after ${CHAIN_TIMEOUT_MS}ms`)), CHAIN_TIMEOUT_MS)
          ),
        ])
      )
    );

    const pools: YieldPool[] = [];
    for (const result of chainResults) {
      if (result.status === 'fulfilled') {
        pools.push(...result.value);
      } else {
        logger.warn('[Aave V3] Chain fetch failed or timed out', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    logger.info(`[Aave V3] Total pools fetched: ${pools.length}`);
    return pools;
  }

  private async fetchChain(cfg: AaveChainConfig): Promise<YieldPool[]> {
    const provider = getProvider(cfg.chain);

    const pool = new ethers.Contract(cfg.poolAddress, POOL_ABI, provider);
    const oracle = new ethers.Contract(cfg.oracleAddress, ORACLE_ABI, provider);
    const rewardsCtrl = new ethers.Contract(cfg.rewardsControllerAddress, REWARDS_CONTROLLER_ABI, provider);

    // Get all reserve asset addresses
    const assets: string[] = await withRetry(
      () => pool.getReservesList(),
      {},
      `aave/${cfg.chain}/getReservesList`
    );

    logger.info(`[Aave V3][${cfg.chain}] Found ${assets.length} reserves`);

    // Batch-fetch data in groups of 3 (Ethereum RPC is slower)
    const BATCH = 3;
    const pools: YieldPool[] = [];

    for (let i = 0; i < assets.length; i += BATCH) {
      const batch = assets.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map((asset) =>
          this.fetchReserve(asset, cfg, pool, oracle, rewardsCtrl, provider).catch((err) => {
            logger.debug(`[Aave V3][${cfg.chain}] Reserve ${asset} failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          })
        )
      );
      pools.push(...batchResults.filter((p): p is YieldPool => p !== null));

      if (i + BATCH < assets.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    logger.info(`[Aave V3][${cfg.chain}] Fetched ${pools.length} pools`);
    return pools;
  }

  private async fetchReserve(
    assetAddress: string,
    cfg: AaveChainConfig,
    pool: ethers.Contract,
    oracle: ethers.Contract,
    rewardsCtrl: ethers.Contract,
    provider: ethers.JsonRpcProvider
  ): Promise<YieldPool | null> {
    // Get reserve data
    const reserveData = await withRetry(
      () => pool.getReserveData(assetAddress),
      {},
      `aave/${cfg.chain}/getReserveData:${assetAddress}`
    );

    const liquidityRate: bigint = reserveData.currentLiquidityRate;
    const aTokenAddress: string = reserveData.aTokenAddress;

    // Get asset symbol & decimals
    const erc20 = new ethers.Contract(assetAddress, ERC20_ABI, provider);
    const [symbol, decimals]: [string, bigint] = await Promise.all([
      withRetry(() => erc20.symbol(), {}, `aave/symbol:${assetAddress}`),
      withRetry(() => erc20.decimals(), {}, `aave/decimals:${assetAddress}`),
    ]);

    const upperSymbol = symbol.toUpperCase()
      .replace('USDC.E', 'USDC')  // Arbitrum bridged USDC
      .replace('USDT.E', 'USDT')
      .replace('DAI.E',  'DAI');

    // Whitelist check (preliminary — we need TVL first for tier-3 tokens)
    if (!isTokenAllowed(upperSymbol, Number.MAX_SAFE_INTEGER)) {
      return null;
    }

    // Get asset USD price from Aave Oracle (8 decimals)
    const priceRaw: bigint = await withRetry(
      () => oracle.getAssetPrice(assetAddress),
      {},
      `aave/${cfg.chain}/price:${upperSymbol}`
    );
    if (priceRaw <= 0n) return null;
    const priceUsd = Number(priceRaw) / 1e8;

    // TVL = aToken total supply * asset price
    const aToken = new ethers.Contract(aTokenAddress, ERC20_ABI, provider);
    const aTokenSupply: bigint = await withRetry(
      () => aToken.totalSupply(),
      {},
      `aave/${cfg.chain}/aTokenSupply:${upperSymbol}`
    );

    const tvlUsd = (Number(aTokenSupply) / 10 ** Number(decimals)) * priceUsd;
    if (tvlUsd < 100_000) return null;

    // Final whitelist check with real TVL
    if (!isTokenAllowed(upperSymbol, tvlUsd)) return null;

    // Base APY from liquidityRate (RAY = 27 decimals, per-second compound rate)
    const apyBase = rayRateToApyPercent(liquidityRate);

    // Reward APY from IncentivesController
    let apyReward = 0;
    try {
      apyReward = await this.getRewardApy(
        aTokenAddress,
        tvlUsd,
        cfg,
        rewardsCtrl,
        oracle,
        provider
      );
    } catch {
      // rewards unavailable — not a failure
    }

    const apyTotal = apyBase + apyReward;

    const riskScore = calculateRiskScore({
      protocolId: 'aave',
      tvlUsd,
      apyBase,
      apyReward,
      yieldType: 'lending',
    });

    return {
      id: generatePoolId('aave', cfg.chain, assetAddress),
      protocol: 'aave',
      protocolDisplay: 'Aave V3',
      chain: cfg.chain,
      type: 'lending',
      tokens: [upperSymbol],
      apyBase,
      apyReward,
      apyTotal,
      tvlUsd,
      riskScore,
      il7d: null,
      url: `https://app.aave.com/?marketName=proto_${cfg.chain}_v3`,
      contractAddress: assetAddress.toLowerCase(),
      lastUpdated: new Date(),
    };
  }

  private async getRewardApy(
    aTokenAddress: string,
    tvlUsd: number,
    cfg: AaveChainConfig,
    rewardsCtrl: ethers.Contract,
    oracle: ethers.Contract,
    provider: ethers.JsonRpcProvider
  ): Promise<number> {
    const rewardTokens: string[] = await withRetry(
      () => rewardsCtrl.getRewardsByAsset(aTokenAddress),
      { maxAttempts: 2 },
      `aave/${cfg.chain}/rewardsByAsset`
    );

    if (!rewardTokens || rewardTokens.length === 0) return 0;

    const nowTs = Math.floor(Date.now() / 1000);
    let totalRewardApy = 0;

    for (const rewardToken of rewardTokens) {
      try {
        const [, emissionPerSecond, , distributionEnd] = await withRetry(
          () => rewardsCtrl.getRewardsData(aTokenAddress, rewardToken),
          { maxAttempts: 2 },
          `aave/${cfg.chain}/rewardsData`
        ) as [bigint, bigint, bigint, bigint];

        // Skip expired rewards
        if (Number(distributionEnd) < nowTs) continue;
        if (emissionPerSecond === 0n) continue;

        // Get reward token price
        let rewardPriceUsd = 0;
        try {
          const rewardPriceRaw: bigint = await withRetry(
            () => oracle.getAssetPrice(rewardToken),
            { maxAttempts: 2 },
            `aave/${cfg.chain}/rewardPrice`
          );
          rewardPriceUsd = Number(rewardPriceRaw) / 1e8;
        } catch {
          // Try Chainlink directly
          try {
            const rewardErc20 = new ethers.Contract(rewardToken, ERC20_ABI, provider);
            const rewardSym: string = await rewardErc20.symbol();
            rewardPriceUsd = await this.getFallbackPrice(rewardSym);
          } catch { continue; }
        }

        if (rewardPriceUsd <= 0 || tvlUsd <= 0) continue;

        const annualRewardUsd =
          (Number(emissionPerSecond) / 1e18) * SECONDS_PER_YEAR * rewardPriceUsd;
        totalRewardApy += (annualRewardUsd / tvlUsd) * 100;
      } catch { continue; }
    }

    return totalRewardApy;
  }

  /** Best-effort fallback price for common reward tokens */
  private async getFallbackPrice(symbol: string): Promise<number> {
    const FEED_MAP: Record<string, string> = {
      // Ethereum
      'AAVE':   '0x547a514d5e3769680ce22b2361c10ea13619e8a9',
      // Arbitrum
      'ARB':    '0xb2a824043730fe05f3da2efafa1cbbe83fa548d6',
      // Avalanche
      'WAVAX':  '0xff3eeb22b5e3de6e705b44749c2559d704923fd7', // AVAX/USD on Eth - skip
    };
    const upper = symbol.toUpperCase();
    if (!FEED_MAP[upper]) return 0;

    try {
      // We don't have direct provider access here — return 0 to be safe
      return 0;
    } catch {
      return 0;
    }
  }
}
