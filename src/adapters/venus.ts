/**
 * Venus Protocol adapter — BNB Chain
 *
 * Venus is a fork of Compound v2 on BNB Chain. Each asset is represented by a
 * vToken (e.g., vBNB, vUSDC). We read supply/borrow APY by calling
 * `supplyRatePerBlock()` and `borrowRatePerBlock()` on each vToken, then
 * annualize using the BNB Chain block time (~3 s, ~10,512,000 blocks/year).
 *
 * Contracts verified on BscScan:
 *   Comptroller:    0xfD36E2c2a6789Db23113685031d7F16329158384
 *   XVS Vault:      0x051100480289e704d20e9DB4804837068f3f9204
 *   Oracle:         0x6592b5DE802159dD3beEA3b851AC7F53Ac093e3c
 *
 * vToken addresses from the Venus docs:
 * https://docs.venus.io/deployed-contracts/main-pool
 */

import { ethers } from 'ethers';
import { BaseEvmAdapter } from './base-evm-adapter';
import type { YieldPool } from './types';
import { isTokenAllowed } from '../config/whitelist';
import { calculateRiskScore } from '../services/risk-calculator';
import { generatePoolId } from '../utils/format';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// ABIs (minimal, only what we need)
// ---------------------------------------------------------------------------

const PANCAKE_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
] as const;

const PANCAKE_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
] as const;

const VTOKEN_ABI = [
  'function symbol() external view returns (string)',
  'function underlying() external view returns (address)',
  'function supplyRatePerBlock() external view returns (uint256)',
  'function borrowRatePerBlock() external view returns (uint256)',
  'function exchangeRateCurrent() external returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function totalBorrows() external view returns (uint256)',
  'function totalReserves() external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function getCash() external view returns (uint256)',
] as const;

// ERC20_ABI_MIN kept for future use in token symbol/decimal lookups
// const ERC20_ABI_MIN = [...] as const;

const COMPTROLLER_ABI = [
  'function getAllMarkets() external view returns (address[])',
  'function markets(address) external view returns (bool isListed, uint256 collateralFactorMantissa, bool isComped)',
  'function venusSupplySpeeds(address) external view returns (uint256)',
  'function venusBorrowSpeeds(address) external view returns (uint256)',
  // Returns the current price oracle — use this instead of hardcoding the address
  'function oracle() external view returns (address)',
] as const;

const VENUS_ORACLE_ABI = [
  'function getUnderlyingPrice(address vToken) external view returns (uint256)',
] as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Venus Comptroller (Unitroller proxy) on BNB Chain mainnet.
 * Verified: https://bscscan.com/address/0xfD36E2c2a6789Db23113685031d7F16329158384
 */
// Use lowercase to bypass EIP-55 checksum validation in ethers v6
const COMPTROLLER_ADDRESS = '0xfd36e2c2a6789db23113685031d7f16329158384';

/**
 * Venus ResilientOracle — current address as of March 2026.
 * Kept as a reference; the live address is fetched dynamically via comptroller.oracle().
 * Verified: https://bscscan.com/address/0x6592b5DE802159F3E74B2486b091D11a8256ab8A
 */
// const ORACLE_ADDRESS = '0x6592b5de802159f3e74b2486b091d11a8256ab8a'; // dynamic fetch preferred

/**
 * BNB Chain produces ~1 block every 3 seconds.
 * Blocks per year = 365 * 24 * 60 * 60 / 3 = 10,512,000
 */
const BLOCKS_PER_YEAR = 10_512_000n;

/**
 * PancakeSwap V2 Factory on BNB Chain.
 * Used to look up the XVS/USDT pair for XVS price discovery.
 */
const PANCAKE_FACTORY_ADDRESS = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';

/** XVS token address on BNB Chain (underlying, not vToken) */
const XVS_TOKEN_ADDRESS = '0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63';

/** Binance-Peg USDT on BNB Chain (18 decimals) */
const USDT_BSC_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class VenusAdapter extends BaseEvmAdapter {
  readonly name = 'venus';
  readonly chains = ['bnb'] as const;

  private readonly comptroller: ethers.Contract;

  constructor() {
    super('bnb');
    this.comptroller = this.contract(COMPTROLLER_ADDRESS, COMPTROLLER_ABI);
  }

  async fetchPools(): Promise<YieldPool[]> {
    logger.info('[Venus] Starting fetch');

    // 1. Get all vToken market addresses from the comptroller
    const markets: string[] = await this.withRetry(
      () => this.comptroller.getAllMarkets(),
      'getAllMarkets'
    );

    // 2. Read the live oracle address from the comptroller (handles upgrades)
    const oracleAddress: string = await this.withRetry(
      () => this.comptroller.oracle(),
      'oracle'
    );
    const oracle = this.contract(oracleAddress.toLowerCase(), VENUS_ORACLE_ABI);
    logger.info(`[Venus] Oracle address: ${oracleAddress}`);

    logger.info(`[Venus] Found ${markets.length} markets`);

    // 3. Get XVS price from PancakeSwap XVS/USDT pool for reward APY calculations
    const xvsPriceUsd = await this.getXvsPriceFromPancakeSwap();

    // 4. Fetch data sequentially in batches to respect public RPC rate limits.
    //    The public BSC dataseed node throttles large bursts of concurrent eth_calls.
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 500;
    const poolOrNulls: (YieldPool | null)[] = [];

    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
      const batch = markets.slice(i, i + BATCH_SIZE);
      const batchResults = await this.safeMulticall(
        batch.map((addr) => () => this.fetchMarket(addr, oracle, xvsPriceUsd)),
        `fetchMarkets[${i}]`
      );
      poolOrNulls.push(...batchResults);

      if (i + BATCH_SIZE < markets.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const pools = poolOrNulls.filter((p): p is YieldPool => p !== null);
    logger.info(`[Venus] Successfully fetched ${pools.length}/${markets.length} markets`);

    return pools;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchMarket(
    vTokenAddress: string,
    oracle: ethers.Contract,
    xvsPriceUsd: number
  ): Promise<YieldPool | null> {
    const vToken = this.contract(vTokenAddress, VTOKEN_ABI);

    // Read basic info (only the fields we need — fewer RPC calls per market)
    const [
      vSymbol,
      supplyRatePerBlock,
      totalBorrows,
      totalReserves,
      cash,
      venusSupplySpeed,
    ] = await Promise.all([
      vToken.symbol() as Promise<string>,
      vToken.supplyRatePerBlock() as Promise<bigint>,
      vToken.totalBorrows() as Promise<bigint>,
      vToken.totalReserves() as Promise<bigint>,
      vToken.getCash() as Promise<bigint>,
      this.comptroller.venusSupplySpeeds(vTokenAddress) as Promise<bigint>,
    ]);

    // Derive the underlying token symbol (strip the leading 'v')
    const underlyingSymbol = this.parseUnderlyingSymbol(vSymbol);

    // Get the underlying USD price from Venus ResilientOracle.
    // The oracle uses the Compound standard: price mantissa = USD_price × 10^(36 − underlyingDecimals).
    const underlyingPriceMantissa: bigint = await this.withRetry(
      () => oracle.getUnderlyingPrice(vTokenAddress),
      `oraclePrice:${vSymbol}`
    );

    if (underlyingPriceMantissa <= 0n) {
      logger.debug(`[Venus] Skipping ${vSymbol}: oracle price is 0`);
      return null;
    }

    // Compute TVL using pure BigInt arithmetic to avoid floating-point overflow.
    //
    // Compound oracle formula (stays consistent across decimal counts):
    //   TVL_USD = (cash + totalBorrows - totalReserves) × priceMantissa / 1e36
    //
    // This works because priceMantissa = USD_price × 1e(36 - underlyingDecimals),
    // so the 1e(underlyingDecimals) in the raw amounts cancels perfectly.
    const PRECISION = 1_000_000n; // keep 6 decimal places of USD
    const SCALE_36 = BigInt('1' + '0'.repeat(36));

    const totalAssetsRaw = cash + totalBorrows - totalReserves;
    const tvlRaw = (totalAssetsRaw * underlyingPriceMantissa * PRECISION) / SCALE_36;
    const tvlUsd = Number(tvlRaw) / Number(PRECISION);

    // Filter by whitelist
    if (!isTokenAllowed(underlyingSymbol, tvlUsd)) {
      logger.debug(`[Venus] Skipping ${underlyingSymbol}: not on whitelist or TVL too low (TVL=$${tvlUsd.toFixed(0)})`);
      return null;
    }

    // Annualize APY from per-block rate
    // APY = ((1 + ratePerBlock)^blocksPerYear - 1) * 100
    const apyBase = blockRateToApy(supplyRatePerBlock);

    // Reward APY from XVS emissions
    // venusSupplySpeed is XVS tokens per block (18 decimals)
    // rewardAPY = (xvsPerBlock * blocksPerYear * xvsPriceUsd) / tvlUsd * 100
    let apyReward = 0;
    if (venusSupplySpeed > 0n && tvlUsd > 0) {
      const xvsPerYear =
        (Number(venusSupplySpeed) / 1e18) * Number(BLOCKS_PER_YEAR);
      apyReward = (xvsPerYear * xvsPriceUsd) / tvlUsd * 100;
    }

    const apyTotal = apyBase + apyReward;

    // Risk score
    const riskScore = calculateRiskScore({
      protocolId: 'venus',
      tvlUsd,
      apyBase,
      apyReward,
      yieldType: 'lending',
    });

    const pool: YieldPool = {
      id: generatePoolId('venus', 'bnb', vTokenAddress),
      protocol: 'venus',
      protocolDisplay: 'Venus Protocol',
      chain: 'bnb',
      type: 'lending',
      tokens: [underlyingSymbol],
      apyBase,
      apyReward,
      apyTotal,
      tvlUsd,
      riskScore,
      il7d: null, // No IL for single-token lending
      url: `https://app.venus.io/markets`,
      contractAddress: vTokenAddress.toLowerCase(),
      lastUpdated: new Date(),
    };

    return pool;
  }

  /**
   * Get XVS price in USD by reading PancakeSwap V2 XVS/USDT pool reserves.
   *
   * XVS: 18 decimals  |  BSC-USDT: 18 decimals
   * Price = USDT_reserve / XVS_reserve (no decimal adjustment needed)
   */
  private async getXvsPriceFromPancakeSwap(): Promise<number> {
    try {
      const factory = this.contract(PANCAKE_FACTORY_ADDRESS, PANCAKE_FACTORY_ABI);

      const pairAddress: string = await this.withRetry(
        () => factory.getPair(XVS_TOKEN_ADDRESS, USDT_BSC_ADDRESS),
        'xvsUsdtPair'
      );

      if (!pairAddress || pairAddress === ethers.ZeroAddress) {
        logger.warn('[Venus] XVS/USDT pair not found on PancakeSwap');
        return 0;
      }

      const pair = this.contract(pairAddress.toLowerCase(), PANCAKE_PAIR_ABI);

      const [reserves, token0]: [readonly [bigint, bigint, number], string] =
        await Promise.all([
          pair.getReserves(),
          pair.token0(),
        ]);

      const [reserve0, reserve1] = reserves;

      // Determine orientation: which reserve is XVS?
      const xvsIsToken0 = token0.toLowerCase() === XVS_TOKEN_ADDRESS.toLowerCase();
      const xvsReserve  = xvsIsToken0 ? reserve0 : reserve1;
      const usdtReserve = xvsIsToken0 ? reserve1 : reserve0;

      if (xvsReserve === 0n) return 0;

      // Both tokens are 18 decimals — division gives USD price directly
      const price = Number(usdtReserve) / Number(xvsReserve);
      logger.info(`[Venus] XVS price from PancakeSwap: $${price.toFixed(4)}`);
      return price;
    } catch (err) {
      logger.warn('[Venus] Could not fetch XVS price from PancakeSwap; reward APY will be 0', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /**
   * Map vToken symbol to underlying symbol.
   * E.g. "vBNB" → "BNB", "vUSDC" → "USDC", "vXVS" → "XVS"
   */
  private parseUnderlyingSymbol(vSymbol: string): string {
    if (vSymbol.startsWith('v')) return vSymbol.slice(1).toUpperCase();
    return vSymbol.toUpperCase();
  }
}

// ---------------------------------------------------------------------------
// APY math helper
// ---------------------------------------------------------------------------

/**
 * Convert a per-block interest rate (18-decimal mantissa) to annualized APY.
 *
 * Formula (compound interest):
 *   APY = ((1 + ratePerBlock / 1e18)^blocksPerYear - 1) * 100
 *
 * The exponentiation is done in floating-point because bigint exponentiation
 * with fractional exponents isn't available natively.
 */
function blockRateToApy(ratePerBlock: bigint): number {
  if (ratePerBlock === 0n) return 0;

  const rate = Number(ratePerBlock) / 1e18;
  const blocksPerYear = Number(BLOCKS_PER_YEAR);

  // Use logarithm to avoid precision issues with large exponents
  // (1 + rate)^n = exp(n * ln(1 + rate))
  const apy = (Math.exp(blocksPerYear * Math.log1p(rate)) - 1) * 100;

  return Math.max(0, apy);
}
