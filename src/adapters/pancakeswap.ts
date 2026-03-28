/**
 * PancakeSwap V2 Adapter — BNB Chain
 *
 * Reads LP pool data from PancakeSwap V2 Factory and farm reward data
 * from MasterChef V2. Only includes pools where BOTH tokens are on the
 * whitelist.
 *
 * APY breakdown:
 *   apyBase   = 0 (trading fee APY requires off-chain volume data)
 *   apyReward = CAKE emissions / staked TVL × 100
 *
 * Contracts (BscScan verified):
 *   Factory V2:    0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
 *   MasterChef V2: 0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652
 *   CAKE token:    0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
 */

import { ethers } from 'ethers';
import { BaseEvmAdapter, AGGREGATOR_V3_ABI, ERC20_ABI } from './base-evm-adapter';
import type { YieldPool } from './types';
import { isTokenAllowed } from '../config/whitelist';
import { calculateRiskScore } from '../services/risk-calculator';
import { generatePoolId } from '../utils/format';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const MASTERCHEF_V2_ABI = [
  'function poolLength() external view returns (uint256)',
  'function lpToken(uint256 pid) external view returns (address)',
  'function poolInfo(uint256 pid) external view returns (uint256 accCakePerShare, uint256 lastRewardBlock, uint256 allocPoint, uint256 totalBoostedShare, bool isRegular)',
  'function cakePerBlock(bool isRegular) external view returns (uint256)',
  'function totalRegularAllocPoint() external view returns (uint256)',
  'function totalSpecialAllocPoint() external view returns (uint256)',
] as const;

const PAIR_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() external view returns (uint256)',
] as const;

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
] as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASTERCHEF_V2     = '0xa5f8c5dbd5f286960b9d90548680ae5ebff07652';
const CAKE_TOKEN        = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
const WBNB_TOKEN        = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const FACTORY_V2        = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';

/** Chainlink BNB/USD feed on BNB Chain */
const BNB_USD_FEED      = '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';
/** Chainlink CAKE/USD feed on BNB Chain */
const CAKE_USD_FEED     = '0xb6064ed41d4f67e353768aa239ca98f4b6e3cf7f';

/** BNB Chain blocks per year (3-second blocks) */
const BLOCKS_PER_YEAR   = 10_512_000;

/** Only scan this many MasterChef pools to limit RPC calls */
const MAX_POOLS_TO_SCAN = 80;

// Known BNB Chain token addresses → symbols for fast whitelist checks
// (avoids one ERC20.symbol() call per token in the happy path)
const KNOWN_TOKEN_SYMBOLS: Record<string, string> = {
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': 'CAKE',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB',
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'BTCB',
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ETH',
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': 'DAI',
  '0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63': 'XVS',
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD', // not whitelisted but needed for filtering
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PancakeSwapAdapter extends BaseEvmAdapter {
  readonly name = 'pancakeswap';
  readonly chains = ['bnb'] as const;

  private readonly masterChef: ethers.Contract;

  constructor() {
    super('bnb');
    this.masterChef = this.contract(MASTERCHEF_V2, MASTERCHEF_V2_ABI);
  }

  async fetchPools(): Promise<YieldPool[]> {
    logger.info('[PancakeSwap] Starting fetch');

    // 1. Fetch CAKE price (used for all reward APY calculations)
    const [cakePriceUsd, bnbPriceUsd] = await Promise.all([
      this.getCakePrice(),
      this.getBnbPrice(),
    ]);
    logger.info(`[PancakeSwap] CAKE=$${cakePriceUsd.toFixed(4)}, BNB=$${bnbPriceUsd.toFixed(2)}`);

    // 2. Get global farm parameters
    const [poolLengthRaw, cakePerBlockRegular, cakePerBlockSpecial, totalRegularAlloc, totalSpecialAlloc] =
      await Promise.all([
        this.withRetry(() => this.masterChef.poolLength(), 'poolLength') as Promise<bigint>,
        this.withRetry(() => this.masterChef.cakePerBlock(true),  'cakePerBlockRegular') as Promise<bigint>,
        this.withRetry(() => this.masterChef.cakePerBlock(false), 'cakePerBlockSpecial') as Promise<bigint>,
        this.withRetry(() => this.masterChef.totalRegularAllocPoint(), 'totalRegularAlloc') as Promise<bigint>,
        this.withRetry(() => this.masterChef.totalSpecialAllocPoint(), 'totalSpecialAlloc') as Promise<bigint>,
      ]);

    const poolLength = Math.min(Number(poolLengthRaw), MAX_POOLS_TO_SCAN);
    logger.info(`[PancakeSwap] Scanning ${poolLength} / ${Number(poolLengthRaw)} pools`);

    // 3. Fetch all lpToken addresses in one go
    const lpAddresses = await this.safeMulticall(
      Array.from({ length: poolLength }, (_, i) => () => this.masterChef.lpToken(i) as Promise<string>),
      'lpTokens'
    );

    // 4. Fetch poolInfo for all pools in parallel
    const poolInfos = await this.safeMulticall(
      Array.from({ length: poolLength }, (_, i) => () => this.masterChef.poolInfo(i)),
      'poolInfos'
    );

    // 5. Process each pool — batch in groups of 5 with delay
    const BATCH = 5;
    const results: (YieldPool | null)[] = [];

    for (let i = 0; i < poolLength; i += BATCH) {
      const batchIndices = Array.from({ length: Math.min(BATCH, poolLength - i) }, (_, j) => i + j);
      const batchResults = await Promise.all(
        batchIndices.map(async (pid) => {
          const lpAddr = lpAddresses[pid];
          const info   = poolInfos[pid] as { allocPoint: bigint; isRegular: boolean } | null;
          if (!lpAddr || !info) return null;
          if (info.allocPoint === 0n) return null; // pool disabled

          const globalCakePerBlock = info.isRegular ? cakePerBlockRegular : cakePerBlockSpecial;
          const totalAlloc         = info.isRegular ? totalRegularAlloc   : totalSpecialAlloc;

          if (totalAlloc === 0n) return null;

          try {
            return await this.fetchPool(
              pid,
              lpAddr as string,
              info,
              globalCakePerBlock,
              totalAlloc,
              cakePriceUsd,
              bnbPriceUsd
            );
          } catch (err) {
            logger.debug(`[PancakeSwap] Pool ${pid} failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        })
      );
      results.push(...batchResults);

      if (i + BATCH < poolLength) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const pools = results.filter((p): p is YieldPool => p !== null);
    logger.info(`[PancakeSwap] Successfully fetched ${pools.length} pools`);
    return pools;
  }

  // ---------------------------------------------------------------------------
  // Per-pool fetch
  // ---------------------------------------------------------------------------

  private async fetchPool(
    pid: number,
    lpAddress: string,
    info: { allocPoint: bigint; isRegular: boolean },
    globalCakePerBlock: bigint,
    totalAlloc: bigint,
    cakePriceUsd: number,
    bnbPriceUsd: number
  ): Promise<YieldPool | null> {
    const pair = this.contract(lpAddress.toLowerCase(), PAIR_ABI);

    const [token0Addr, token1Addr, reserves, lpTotalSupply] = await Promise.all([
      pair.token0() as Promise<string>,
      pair.token1() as Promise<string>,
      pair.getReserves() as Promise<readonly [bigint, bigint, number]>,
      pair.totalSupply() as Promise<bigint>,
    ]);

    const t0 = token0Addr.toLowerCase();
    const t1 = token1Addr.toLowerCase();

    // Resolve token symbols
    const [sym0, sym1] = await Promise.all([
      this.getTokenSymbol(t0),
      this.getTokenSymbol(t1),
    ]);

    if (!sym0 || !sym1) return null;

    // Check whitelist (both tokens must be allowed; TVL check done below)
    // We pass 0 for TVL in the whitelist check and re-check after calculating TVL
    if (!isTokenAllowed(sym0, Number.MAX_SAFE_INTEGER) || !isTokenAllowed(sym1, Number.MAX_SAFE_INTEGER)) {
      logger.debug(`[PancakeSwap] Pool ${pid} (${sym0}/${sym1}): token(s) not whitelisted`);
      return null;
    }

    const [reserve0, reserve1] = reserves;

    // Get token prices
    const price0 = await this.getTokenPriceUsd(t0, sym0, bnbPriceUsd);
    const price1 = await this.getTokenPriceUsd(t1, sym1, bnbPriceUsd);

    if (price0 <= 0 || price1 <= 0) return null;

    const decimals0 = await this.getDecimals(t0);
    const decimals1 = await this.getDecimals(t1);

    const val0 = (Number(reserve0) / 10 ** decimals0) * price0;
    const val1 = (Number(reserve1) / 10 ** decimals1) * price1;
    const totalPoolTvlUsd = val0 + val1;

    if (totalPoolTvlUsd < 100_000) return null; // skip tiny pools

    // Re-check whitelist with real TVL
    if (!isTokenAllowed(sym0, totalPoolTvlUsd) || !isTokenAllowed(sym1, totalPoolTvlUsd)) return null;

    // Staked LP tokens in MasterChef (used for reward APY denominator)
    const lpErc20 = this.contract(lpAddress.toLowerCase(), ERC20_ABI);
    const stakedLP: bigint = await this.withRetry(
      () => lpErc20.balanceOf(MASTERCHEF_V2),
      `stakedLP:${pid}`
    );

    if (lpTotalSupply === 0n || stakedLP === 0n) return null;

    const stakedFraction = Number(stakedLP) / Number(lpTotalSupply);
    const stakedTvlUsd   = totalPoolTvlUsd * stakedFraction;

    // CAKE reward APY
    // poolCakePerBlock = globalCakePerBlock * allocPoint / totalAllocPoint
    const poolCakePerBlock = (globalCakePerBlock * info.allocPoint) / totalAlloc;
    const cakePerYear      = (Number(poolCakePerBlock) / 1e18) * BLOCKS_PER_YEAR;
    const apyReward        = stakedTvlUsd > 0
      ? (cakePerYear * cakePriceUsd / stakedTvlUsd) * 100
      : 0;

    const riskScore = calculateRiskScore({
      protocolId: 'pancakeswap',
      tvlUsd: totalPoolTvlUsd,
      apyBase: 0,
      apyReward,
      yieldType: 'lp',
      ilScoreOverride: sym0.includes('USD') && sym1.includes('USD') ? 1 : undefined,
    });

    return {
      id: generatePoolId('pancakeswap', 'bnb', lpAddress),
      protocol: 'pancakeswap',
      protocolDisplay: 'PancakeSwap',
      chain: 'bnb',
      type: 'lp',
      tokens: [sym0, sym1],
      apyBase: 0,
      apyReward,
      apyTotal: apyReward,
      tvlUsd: totalPoolTvlUsd,
      riskScore,
      il7d: null,
      url: `https://pancakeswap.finance/farms`,
      contractAddress: lpAddress.toLowerCase(),
      lastUpdated: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // Price helpers
  // ---------------------------------------------------------------------------

  /** Get CAKE price from Chainlink CAKE/USD feed on BNB Chain */
  private async getCakePrice(): Promise<number> {
    try {
      const feed = this.contract(CAKE_USD_FEED, AGGREGATOR_V3_ABI);
      const [, answer] = await this.withRetry(
        () => feed.latestRoundData(),
        'cakeUsdFeed'
      ) as readonly [unknown, bigint, ...unknown[]];
      return Number(answer) / 1e8;
    } catch {
      // Fallback: use CAKE/BNB pair + BNB/USD
      return this.getCakePriceViaPair();
    }
  }

  /** Fallback: read CAKE/WBNB pair reserves and multiply by BNB price */
  private async getCakePriceViaPair(): Promise<number> {
    try {
      const factory = this.contract(FACTORY_V2, FACTORY_ABI);
      const pairAddr: string = await this.withRetry(
        () => factory.getPair(CAKE_TOKEN, WBNB_TOKEN),
        'cakeBnbPair'
      );
      if (!pairAddr || pairAddr === ethers.ZeroAddress) return 0;

      const pair = this.contract(pairAddr.toLowerCase(), PAIR_ABI);
      const [reserves, token0]: [readonly [bigint, bigint, number], string] = await Promise.all([
        pair.getReserves(),
        pair.token0(),
      ]);
      const [r0, r1] = reserves;
      const cakeIsTok0 = token0.toLowerCase() === CAKE_TOKEN.toLowerCase();
      const cakeRes    = cakeIsTok0 ? r0 : r1;
      const bnbRes     = cakeIsTok0 ? r1 : r0;

      if (cakeRes === 0n) return 0;
      const bnbPrice = await this.getBnbPrice();
      return (Number(bnbRes) / Number(cakeRes)) * bnbPrice;
    } catch {
      return 0;
    }
  }

  /** Get BNB price from Chainlink BNB/USD feed */
  private async getBnbPrice(): Promise<number> {
    try {
      const feed = this.contract(BNB_USD_FEED, AGGREGATOR_V3_ABI);
      const [, answer] = await this.withRetry(
        () => feed.latestRoundData(),
        'bnbUsdFeed'
      ) as readonly [unknown, bigint, ...unknown[]];
      return Number(answer) / 1e8;
    } catch {
      return 600; // reasonable BNB fallback
    }
  }

  // ---------------------------------------------------------------------------
  // Token price lookup
  // ---------------------------------------------------------------------------

  private async getTokenPriceUsd(
    address: string,
    symbol: string,
    bnbPriceUsd: number
  ): Promise<number> {
    const sym = symbol.toUpperCase();

    // Stablecoins: assume $1
    if (['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX'].includes(sym)) return 1.0;

    // WBNB / BNB
    if (['WBNB', 'BNB'].includes(sym)) return bnbPriceUsd;

    // CAKE: already fetched in main flow — re-fetch here is fine (cached by provider)
    if (sym === 'CAKE') return this.getCakePrice();

    // For BTC variants, try Chainlink BTC/USD on BNB Chain
    if (['BTC', 'BTCB', 'WBTC'].includes(sym)) {
      return this.getChainlinkPrice('0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf');
    }

    // ETH variants
    if (['ETH', 'WETH'].includes(sym)) {
      return this.getChainlinkPrice('0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e');
    }

    // XVS: use USDT pair (same logic as Venus adapter)
    if (sym === 'XVS') {
      return this.getPriceFromUsdtPair(address, 18);
    }

    // Generic fallback: try a USDT or WBNB DEX pair
    try {
      const priceViaUsdt = await this.getPriceFromUsdtPair(address, 18);
      if (priceViaUsdt > 0) return priceViaUsdt;
    } catch { /* ignore */ }

    return 0; // unknown price → pool will be skipped
  }

  private async getChainlinkPrice(feedAddress: string): Promise<number> {
    try {
      const feed = this.contract(feedAddress.toLowerCase(), AGGREGATOR_V3_ABI);
      const [, answer] = await this.withRetry(
        () => feed.latestRoundData(),
        `chainlink:${feedAddress}`
      ) as readonly [unknown, bigint, ...unknown[]];
      return Number(answer) / 1e8;
    } catch {
      return 0;
    }
  }

  private async getPriceFromUsdtPair(tokenAddress: string, _decimals: number): Promise<number> {
    const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
    try {
      const factory = this.contract(FACTORY_V2, FACTORY_ABI);
      const pairAddr: string = await this.withRetry(
        () => factory.getPair(tokenAddress, USDT_BSC),
        `usdtPair:${tokenAddress}`
      );
      if (!pairAddr || pairAddr === ethers.ZeroAddress) return 0;

      const pair = this.contract(pairAddr.toLowerCase(), PAIR_ABI);
      const [reserves, token0]: [readonly [bigint, bigint, number], string] = await Promise.all([
        pair.getReserves(),
        pair.token0(),
      ]);
      const [r0, r1] = reserves;
      const tokIsTok0 = token0.toLowerCase() === tokenAddress.toLowerCase();
      const tokRes    = tokIsTok0 ? r0 : r1;
      const usdtRes   = tokIsTok0 ? r1 : r0;

      if (tokRes === 0n) return 0;
      // Both BSC-USDT and most tokens have 18 decimals on BSC
      return Number(usdtRes) / Number(tokRes);
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Token metadata helpers
  // ---------------------------------------------------------------------------

  private async getTokenSymbol(address: string): Promise<string | null> {
    // Fast path: known tokens
    const known = KNOWN_TOKEN_SYMBOLS[address];
    if (known) return known;

    // Slow path: read from ERC20
    try {
      const erc20 = this.contract(address, ERC20_ABI);
      const sym: string = await this.withRetry(() => erc20.symbol(), `symbol:${address}`, { maxAttempts: 2 });
      return sym.toUpperCase();
    } catch {
      return null;
    }
  }

  private async getDecimals(address: string): Promise<number> {
    // BSC tokens are almost always 18 decimals; USDC is 18 on BSC (unlike Ethereum)
    const EXCEPTIONS: Record<string, number> = {};
    if (EXCEPTIONS[address] !== undefined) return EXCEPTIONS[address];

    try {
      const erc20 = this.contract(address, ERC20_ABI);
      const dec: bigint = await this.withRetry(() => erc20.decimals(), `decimals:${address}`, { maxAttempts: 2 });
      return Number(dec);
    } catch {
      return 18;
    }
  }
}
