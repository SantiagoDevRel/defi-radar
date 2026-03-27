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
import { BaseEvmAdapter } from './base-evm-adapter.js';
import type { YieldPool } from './types.js';
import { isTokenAllowed } from '../config/whitelist.js';
import { calculateRiskScore } from '../services/risk-calculator.js';
import { generatePoolId } from '../utils/format.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// ABIs (minimal, only what we need)
// ---------------------------------------------------------------------------

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

const ERC20_ABI_MIN = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
] as const;

const COMPTROLLER_ABI = [
  'function getAllMarkets() external view returns (address[])',
  'function markets(address) external view returns (bool isListed, uint256 collateralFactorMantissa, bool isComped)',
  'function venusSupplySpeeds(address) external view returns (uint256)',
  'function venusBorrowSpeeds(address) external view returns (uint256)',
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
const COMPTROLLER_ADDRESS = '0xfD36E2c2a6789Db23113685031d7F16329158384';

/**
 * Venus Oracle — returns 18-decimal USD prices for vToken underlyings.
 * Verified: https://bscscan.com/address/0x6592b5DE802159dD3beEA3b851AC7F53Ac093e3c
 */
const ORACLE_ADDRESS = '0x6592b5DE802159dD3beEA3b851AC7F53Ac093e3c';

/**
 * BNB Chain produces ~1 block every 3 seconds.
 * Blocks per year = 365 * 24 * 60 * 60 / 3 = 10,512,000
 */
const BLOCKS_PER_YEAR = 10_512_000n;

/**
 * XVS token address on BNB Chain — needed to price reward emissions.
 * Used to look up XVS/USD price from the oracle.
 */
const XVS_VTOKEN_ADDRESS = '0x151B1e2635A717bcDc836ECd6FbB62B674FE3E1D';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class VenusAdapter extends BaseEvmAdapter {
  readonly name = 'venus';
  readonly chains = ['bnb'] as const;

  private readonly comptroller: ethers.Contract;
  private readonly oracle: ethers.Contract;

  constructor() {
    super('bnb');
    this.comptroller = this.contract(COMPTROLLER_ADDRESS, COMPTROLLER_ABI);
    this.oracle = this.contract(ORACLE_ADDRESS, VENUS_ORACLE_ABI);
  }

  async fetchPools(): Promise<YieldPool[]> {
    logger.info('[Venus] Starting fetch');

    // 1. Get all vToken market addresses from the comptroller
    const markets: string[] = await this.withRetry(
      () => this.comptroller.getAllMarkets(),
      'getAllMarkets'
    );

    logger.info(`[Venus] Found ${markets.length} markets`);

    // 2. Get XVS price for reward APY calculations
    const xvsPriceUsd = await this.getXvsPrice();

    // 3. Fetch data for each market in parallel (with safe fallback)
    const poolOrNulls = await this.safeMulticall(
      markets.map((addr) => () => this.fetchMarket(addr, xvsPriceUsd)),
      'fetchMarkets'
    );

    const pools = poolOrNulls.filter((p): p is YieldPool => p !== null);
    logger.info(`[Venus] Successfully fetched ${pools.length}/${markets.length} markets`);

    return pools;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchMarket(
    vTokenAddress: string,
    xvsPriceUsd: number
  ): Promise<YieldPool | null> {
    const vToken = this.contract(vTokenAddress, VTOKEN_ABI);

    // Read basic info
    const [
      vSymbol,
      supplyRatePerBlock,
      borrowRatePerBlock,
      totalSupply,
      totalBorrows,
      totalReserves,
      cash,
      vDecimals,
      venusSupplySpeed,
    ] = await Promise.all([
      vToken.symbol() as Promise<string>,
      vToken.supplyRatePerBlock() as Promise<bigint>,
      vToken.borrowRatePerBlock() as Promise<bigint>,
      vToken.totalSupply() as Promise<bigint>,
      vToken.totalBorrows() as Promise<bigint>,
      vToken.totalReserves() as Promise<bigint>,
      vToken.getCash() as Promise<bigint>,
      vToken.decimals() as Promise<number>,
      this.comptroller.venusSupplySpeeds(vTokenAddress) as Promise<bigint>,
    ]);

    // Derive the underlying token symbol (strip the leading 'v')
    const underlyingSymbol = this.parseUnderlyingSymbol(vSymbol);

    // Get the underlying USD price from Venus oracle (18-decimal mantissa)
    const underlyingPriceMantissa: bigint = await this.withRetry(
      () => this.oracle.getUnderlyingPrice(vTokenAddress),
      `oraclePrice:${vSymbol}`
    );

    // Oracle returns price with 18 decimals adjusted for token decimals
    const underlyingPriceUsd =
      Number(underlyingPriceMantissa) / 1e18;

    if (underlyingPriceUsd <= 0) {
      logger.debug(`[Venus] Skipping ${vSymbol}: price is 0`);
      return null;
    }

    // Compute TVL in USD
    // TVL = (cash + totalBorrows - totalReserves) * price
    // vToken has 8 decimals; underlying price already adjusted
    const totalAssetsRaw = cash + totalBorrows - totalReserves;
    const totalAssetsNormalized =
      Number(totalAssetsRaw) / Math.pow(10, vDecimals);
    const tvlUsd = totalAssetsNormalized * underlyingPriceUsd;

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
   * Get XVS price in USD by reading from the Venus oracle.
   * Falls back to 0 if the oracle call fails (reward APY will show 0).
   */
  private async getXvsPrice(): Promise<number> {
    try {
      const priceMantissa: bigint = await this.withRetry(
        () => this.oracle.getUnderlyingPrice(XVS_VTOKEN_ADDRESS),
        'xvsPrice'
      );
      return Number(priceMantissa) / 1e18;
    } catch (err) {
      logger.warn('[Venus] Could not fetch XVS price; reward APY will be 0', {
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
