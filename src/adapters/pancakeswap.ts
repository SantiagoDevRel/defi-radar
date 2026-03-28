/**
 * PancakeSwap V2 Adapter — BNB Chain
 *
 * Shows top PancakeSwap V2 LP pools by TVL.
 *
 * Note: PancakeSwap V2 MasterChef farms have been largely deprecated following
 * the V3 migration (2023). Active CAKE farm rewards migrated to MasterChef V3
 * and the new CakePool. This adapter shows V2 LP pool TVL only.
 *
 * apyBase  = 0 (trading fee APY requires off-chain volume data not available here)
 * apyReward = 0 (V2 MasterChef farms are deprecated; totalRegularAllocPoint ≈ 1)
 *
 * Contracts (BscScan verified):
 *   Factory V2: 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
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

const PAIR_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
] as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Chainlink BNB/USD feed on BNB Chain */
const BNB_USD_FEED  = '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';
/** Chainlink CAKE/USD feed on BNB Chain */
const CAKE_USD_FEED = '0xb6064ed41d4f67e353768aa239ca98f4b6e3cf7f';
/** Chainlink BTC/USD feed on BNB Chain */
const BTC_USD_FEED  = '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf';
/** Chainlink ETH/USD feed on BNB Chain */
const ETH_USD_FEED  = '0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e';

const WBNB_TOKEN = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

// Top PancakeSwap V2 LP pools by TVL (address → [token0_symbol, token1_symbol])
interface KnownPool {
  address: string;
  sym0: string;
  sym1: string;
  addr0: string;
  addr1: string;
}

const TOP_POOLS: KnownPool[] = [
  {
    address: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE',
    sym0: 'USDT', sym1: 'WBNB',
    addr0: '0x55d398326f99059ff775485246999027b3197955',
    addr1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  },
  {
    address: '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0',
    sym0: 'CAKE', sym1: 'WBNB',
    addr0: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
    addr1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  },
  {
    address: '0x74E4716E431f45807DCF19f284c7aA99F18a4fbc',
    sym0: 'ETH', sym1: 'WBNB',
    addr0: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
    addr1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  },
  {
    address: '0x61EB789d75A95CAa3fF50ed7E47b96c132fEc082',
    sym0: 'BTCB', sym1: 'WBNB',
    addr0: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
    addr1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  },
  {
    address: '0xd99c7F6C65857AC913a8f880A4cb84032AB2FC5b',
    sym0: 'USDC', sym1: 'WBNB',
    addr0: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    addr1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  },
  {
    address: '0xEc6557348085Aa57C72514D67070dC863C0a5A8c',
    sym0: 'USDT', sym1: 'USDC',
    addr0: '0x55d398326f99059ff775485246999027b3197955',
    addr1: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  },
];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PancakeSwapAdapter extends BaseEvmAdapter {
  readonly name = 'pancakeswap';
  readonly chains = ['bnb'] as const;

  constructor() {
    super('bnb');
  }

  async fetchPools(): Promise<YieldPool[]> {
    logger.info('[PancakeSwap] Starting fetch (top V2 LP pools)');

    // Fetch all prices in parallel
    const [bnbPriceUsd, cakePriceUsd, btcPriceUsd, ethPriceUsd] = await Promise.all([
      this.getChainlinkPrice(BNB_USD_FEED, 'BNB'),
      this.getChainlinkPrice(CAKE_USD_FEED, 'CAKE'),
      this.getChainlinkPrice(BTC_USD_FEED, 'BTC'),
      this.getChainlinkPrice(ETH_USD_FEED, 'ETH'),
    ]);

    logger.info(
      `[PancakeSwap] Prices — BNB=$${bnbPriceUsd.toFixed(2)} CAKE=$${cakePriceUsd.toFixed(3)} BTC=$${btcPriceUsd.toFixed(0)} ETH=$${ethPriceUsd.toFixed(0)}`
    );

    const priceMap: Record<string, number> = {
      'WBNB': bnbPriceUsd,
      'BNB':  bnbPriceUsd,
      'CAKE': cakePriceUsd,
      'BTCB': btcPriceUsd,
      'BTC':  btcPriceUsd,
      'ETH':  ethPriceUsd,
      'WETH': ethPriceUsd,
      'USDT': 1.0,
      'USDC': 1.0,
      'DAI':  1.0,
      'BUSD': 1.0,
    };

    const results = await Promise.allSettled(
      TOP_POOLS.map((pool) => this.fetchPool(pool, priceMap))
    );

    const pools: YieldPool[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) {
        pools.push(r.value);
      } else if (r.status === 'rejected') {
        logger.debug('[PancakeSwap] Pool fetch failed', {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }

    logger.info(`[PancakeSwap] Fetched ${pools.length} pools`);
    return pools;
  }

  private async fetchPool(
    pool: KnownPool,
    priceMap: Record<string, number>
  ): Promise<YieldPool | null> {
    const { sym0, sym1 } = pool;

    // Whitelist check
    if (!isTokenAllowed(sym0, Number.MAX_SAFE_INTEGER) || !isTokenAllowed(sym1, Number.MAX_SAFE_INTEGER)) {
      return null;
    }

    const price0 = priceMap[sym0] ?? 0;
    const price1 = priceMap[sym1] ?? 0;
    if (price0 <= 0 || price1 <= 0) return null;

    const pair = this.contract(pool.address.toLowerCase(), PAIR_ABI);
    const reserves = await this.withRetry(
      () => pair.getReserves(),
      `reserves:${sym0}/${sym1}`
    ) as readonly [bigint, bigint, number];

    // Determine which reserve corresponds to which token
    // by checking which token address is token0
    const pairContract = this.contract(pool.address.toLowerCase(), PAIR_ABI);
    const token0Addr: string = await this.withRetry(
      () => pairContract.token0(),
      `token0:${sym0}/${sym1}`
    );

    const sym0IsToken0 = token0Addr.toLowerCase() === pool.addr0.toLowerCase();
    const r0 = sym0IsToken0 ? reserves[0] : reserves[1];
    const r1 = sym0IsToken0 ? reserves[1] : reserves[0];

    // Get decimals for each token
    const dec0 = await this.getDecimals(pool.addr0);
    const dec1 = await this.getDecimals(pool.addr1);

    const val0 = (Number(r0) / 10 ** dec0) * price0;
    const val1 = (Number(r1) / 10 ** dec1) * price1;
    const tvlUsd = val0 + val1;

    if (tvlUsd < 100_000) return null;

    if (!isTokenAllowed(sym0, tvlUsd) || !isTokenAllowed(sym1, tvlUsd)) return null;

    const riskScore = calculateRiskScore({
      protocolId: 'pancakeswap',
      tvlUsd,
      apyBase: 0,
      apyReward: 0,
      yieldType: 'lp',
    });

    return {
      id: generatePoolId('pancakeswap', 'bnb', pool.address),
      protocol: 'pancakeswap',
      protocolDisplay: 'PancakeSwap',
      chain: 'bnb',
      type: 'lp',
      tokens: [sym0, sym1],
      apyBase: 0,
      apyReward: 0,
      apyTotal: 0,
      tvlUsd,
      riskScore,
      il7d: null,
      url: `https://pancakeswap.finance/v2/pair/${pool.address}`,
      contractAddress: pool.address.toLowerCase(),
      lastUpdated: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async getChainlinkPrice(feedAddress: string, symbol: string): Promise<number> {
    try {
      const feed = this.contract(feedAddress, AGGREGATOR_V3_ABI);
      const [, answer] = await this.withRetry(
        () => feed.latestRoundData(),
        `chainlink:${symbol}`
      ) as readonly [unknown, bigint, ...unknown[]];
      return Number(answer) / 1e8;
    } catch {
      return 0;
    }
  }

  private async getDecimals(tokenAddress: string): Promise<number> {
    try {
      const erc20 = this.contract(tokenAddress.toLowerCase(), ERC20_ABI);
      const dec: bigint = await this.withRetry(() => erc20.decimals(), `decimals:${tokenAddress}`);
      return Number(dec);
    } catch {
      return 18;
    }
  }
}
