/**
 * APY calculation helpers.
 *
 * All functions operate on decimal rates (e.g. 0.05 = 5%) unless
 * the function name ends in "Percent" (returns 5.0 for 5%).
 */

/**
 * Convert an annual interest rate (27-decimal RAY format, used by Aave V3)
 * to annualized APY percentage.
 *
 * In Aave V3, `currentLiquidityRate` is the ANNUAL APR in RAY format (1e27 = 100%).
 * We divide by SECONDS_PER_YEAR to get the per-second rate, then compound.
 *
 * Formula: APY = ((1 + annualRate/RAY/SECONDS_PER_YEAR)^SECONDS_PER_YEAR - 1) * 100
 *
 * @param rayRate - BigInt annual APR in 27-decimal RAY format
 */
export function rayRateToApyPercent(rayRate: bigint): number {
  if (rayRate === 0n) return 0;

  const SECONDS_PER_YEAR = 31_536_000;
  // rayRate / 1e27 is the annual APR (e.g. 0.0178 = 1.78% APR)
  const annualRate = Number(rayRate) / 1e27;
  const ratePerSecond = annualRate / SECONDS_PER_YEAR;

  return (Math.exp(SECONDS_PER_YEAR * Math.log1p(ratePerSecond)) - 1) * 100;
}

/**
 * Convert a per-block interest rate (18-decimal WAD format, used by Compound/Venus)
 * to annualized APY percentage.
 *
 * @param wadRate     - BigInt per-block rate with 18 decimals
 * @param blocksPerYear - Blocks per year for the target chain
 */
export function wadBlockRateToApyPercent(
  wadRate: bigint,
  blocksPerYear: number
): number {
  if (wadRate === 0n) return 0;

  const rate = Number(wadRate) / 1e18;
  return (Math.exp(blocksPerYear * Math.log1p(rate)) - 1) * 100;
}

/**
 * Calculate the combined APY when base and reward APYs compound together.
 *
 * In practice most UIs just add them, but this gives the mathematically
 * correct combined rate for display purposes.
 *
 * @param apyBasePercent   - base APY as percentage (e.g. 3.5)
 * @param apyRewardPercent - reward APY as percentage (e.g. 8.2)
 */
export function combinedApyPercent(
  apyBasePercent: number,
  apyRewardPercent: number
): number {
  // Convert percentages to decimals, compound, convert back
  const base = apyBasePercent / 100;
  const reward = apyRewardPercent / 100;
  return ((1 + base) * (1 + reward) - 1) * 100;
}

/**
 * Estimate 7-day impermanent loss for a constant-product (xy=k) LP
 * given the price ratio change of the two assets.
 *
 * IL = 2√r/(1+r) - 1 where r = price1/price0
 *
 * Returns a negative percentage (loss), e.g. -0.5 means 0.5% IL.
 * Returns null if price data is unavailable.
 *
 * @param priceRatioNow  - current price(token1)/price(token0)
 * @param priceRatio7dAgo - price ratio 7 days ago
 */
export function estimateIL7d(
  priceRatioNow: number,
  priceRatio7dAgo: number
): number | null {
  if (priceRatio7dAgo <= 0 || priceRatioNow <= 0) return null;

  const r = priceRatioNow / priceRatio7dAgo;
  const il = (2 * Math.sqrt(r)) / (1 + r) - 1;
  return il * 100; // returns negative value in percent
}

/**
 * Annualize a rate given as a raw APR percentage (simple interest).
 * Converts to compound APY.
 *
 * @param aprPercent - Simple APR as percentage
 * @param compoundingsPerYear - Compoundings per year (e.g. 365 for daily)
 */
export function aprToApy(aprPercent: number, compoundingsPerYear: number): number {
  const apr = aprPercent / 100;
  return (Math.pow(1 + apr / compoundingsPerYear, compoundingsPerYear) - 1) * 100;
}

/**
 * Calculate the USD value of token emissions per year.
 *
 * @param emissionsPerBlock - Token emissions per block (human-readable, not raw)
 * @param blocksPerYear
 * @param tokenPriceUsd
 * @param tvlUsd - Total value locked in the pool
 * @returns reward APY as percentage
 */
export function rewardApyPercent(
  emissionsPerBlock: number,
  blocksPerYear: number,
  tokenPriceUsd: number,
  tvlUsd: number
): number {
  if (tvlUsd <= 0 || tokenPriceUsd <= 0) return 0;
  const annualRewardUsd = emissionsPerBlock * blocksPerYear * tokenPriceUsd;
  return (annualRewardUsd / tvlUsd) * 100;
}
