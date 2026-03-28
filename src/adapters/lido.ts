/**
 * Lido Adapter — Ethereum staking
 *
 * stETH is a liquid staking token that rebases daily as Ethereum validators
 * earn staking rewards. We calculate the APR from recent on-chain rebase
 * events rather than relying on any external API.
 *
 * Method:
 *   1. Query stETH `TokenRebased` events for the last 7 days.
 *   2. From the most recent event, compute:
 *      APR = (postTotalEther − preTotalEther) / preTotalEther
 *              × (SECONDS_PER_YEAR / timeElapsed) × 100
 *   3. TVL = stETH.totalSupply() × ETH/USD price (Chainlink)
 *
 * stETH contract: 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84 (Ethereum mainnet)
 * Verified: https://etherscan.io/address/0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84
 *
 * TokenRebased event (added in stETH V2, May 2023):
 *   event TokenRebased(
 *     uint256 indexed reportTimestamp,
 *     uint256 timeElapsed,
 *     uint256 preTotalShares,
 *     uint256 preTotalEther,
 *     uint256 postTotalShares,
 *     uint256 postTotalEther,
 *     uint256 sharesMintedAsFees
 *   )
 */

import { ethers } from 'ethers';
import { getProvider, withRetry, AGGREGATOR_V3_ABI } from './base-evm-adapter';
import type { ProtocolAdapter, YieldPool } from './types';
import { calculateRiskScore } from '../services/risk-calculator';
import { generatePoolId } from '../utils/format';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STETH_ADDRESS       = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const ETH_USD_FEED        = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419'; // Chainlink ETH/USD on Ethereum
const SECONDS_PER_YEAR    = 31_536_000;
const BLOCKS_PER_DAY_ETH  = 7200; // ~12-second blocks

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const STETH_ABI = [
  'function totalSupply() external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  // TokenRebased event
  `event TokenRebased(
    uint256 indexed reportTimestamp,
    uint256 timeElapsed,
    uint256 preTotalShares,
    uint256 preTotalEther,
    uint256 postTotalShares,
    uint256 postTotalEther,
    uint256 sharesMintedAsFees
  )`,
] as const;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class LidoAdapter implements ProtocolAdapter {
  readonly name = 'lido-finance';
  readonly chains = ['ethereum'] as const;

  async fetchPools(): Promise<YieldPool[]> {
    logger.info('[Lido] Starting fetch');
    return Promise.race([
      this.doFetchPools(),
      new Promise<YieldPool[]>((resolve) =>
        // After 70s, return pool with fallback values rather than timing out completely.
        // This ensures Lido always appears in the dashboard even when Ethereum RPC is slow.
        setTimeout(() => {
          logger.warn('[Lido] Fetch timed out after 70s — returning pool with fallback APY');
          const pool = this.buildFallbackPool();
          resolve([pool]);
        }, 70_000)
      ),
    ]);
  }

  private buildFallbackPool(tvlUsd = 18_000_000_000, apyBase = 4.0): YieldPool {
    const riskScore = calculateRiskScore({
      protocolId: 'lido-finance',
      tvlUsd,
      apyBase,
      apyReward: 0,
      yieldType: 'staking',
    });
    return {
      id: generatePoolId('lido-finance', 'ethereum', STETH_ADDRESS),
      protocol: 'lido-finance',
      protocolDisplay: 'Lido',
      chain: 'ethereum',
      type: 'staking',
      tokens: ['STETH'],
      apyBase,
      apyReward: 0,
      apyTotal: apyBase,
      tvlUsd,
      riskScore,
      il7d: null,
      url: 'https://stake.lido.fi',
      contractAddress: STETH_ADDRESS,
      lastUpdated: new Date(),
    };
  }

  private async doFetchPools(): Promise<YieldPool[]> {
    const provider = getProvider('ethereum');

    let ethPriceUsd = 0;
    let totalSupply = 0n;
    try {
      [ethPriceUsd, totalSupply] = await Promise.race([
        Promise.all([
          this.getEthPrice(provider),
          (async () => {
            const steth = new ethers.Contract(STETH_ADDRESS, STETH_ABI, provider);
            return withRetry(() => steth.totalSupply(), { maxAttempts: 2 }, 'lido/totalSupply') as Promise<bigint>;
          })(),
        ]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Lido Ethereum RPC timeout after 35s')), 35_000)
        ),
      ]);
    } catch (err) {
      logger.warn(`[Lido] Ethereum RPC failed: ${err instanceof Error ? err.message : String(err)} — using fallback`);
    }

    logger.info(`[Lido] ETH price: $${ethPriceUsd.toFixed(2)}`);

    // TVL from on-chain supply * price, or well-known fallback ($18B+)
    const tvlUsd = totalSupply > 0n
      ? (Number(totalSupply) / 1e18) * ethPriceUsd
      : 18_000_000_000;

    // Get recent TokenRebased events (capped at 20s)
    const steth2 = new ethers.Contract(STETH_ADDRESS, STETH_ABI, provider);
    const apyBase = await this.calculateApyFromRebases(steth2, provider);
    logger.info(`[Lido] stETH APY: ${apyBase.toFixed(4)}%  TVL: $${(tvlUsd / 1e9).toFixed(2)}B`);

    return [this.buildFallbackPool(tvlUsd, apyBase)];
  }

  // ---------------------------------------------------------------------------
  // APY from rebase events
  // ---------------------------------------------------------------------------

  private async calculateApyFromRebases(
    steth: ethers.Contract,
    provider: ethers.JsonRpcProvider
  ): Promise<number> {
    try {
      const currentBlock = await provider.getBlockNumber();
      // Scan last 14 days — Lido rebases daily so 14 days = ~14 events.
      // Some events may be negative (slashing); we average over positive ones only.
      const fromBlock = currentBlock - BLOCKS_PER_DAY_ETH * 14;

      logger.debug(`[Lido] Querying TokenRebased events blocks ${fromBlock}–${currentBlock}`);

      const filter = steth.filters.TokenRebased();

      // Limit to 20 seconds for the event query — public nodes can be slow
      const events = await Promise.race([
        withRetry(
          () => steth.queryFilter(filter, fromBlock, currentBlock),
          { maxAttempts: 2 },
          'lido/TokenRebased'
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('getLogs timeout')), 20_000)
        ),
      ]);

      if (!events || events.length === 0) {
        logger.warn('[Lido] No TokenRebased events found — using fallback APR');
        return 4.0; // reasonable Ethereum staking fallback
      }

      // Compute APR from each rebase event (skip slashing events where post < pre)
      const aprs: number[] = [];
      for (const e of events) {
        const ev = e as ethers.EventLog;
        const args = ev.args as unknown as {
          timeElapsed: bigint;
          preTotalEther: bigint;
          postTotalEther: bigint;
        };
        if (!args || args.preTotalEther === 0n || args.timeElapsed === 0n) continue;
        const reward = args.postTotalEther - args.preTotalEther;
        if (reward <= 0n) continue; // skip slashing / negative rebase events
        const apr =
          (Number(reward) / Number(args.preTotalEther)) *
          (SECONDS_PER_YEAR / Number(args.timeElapsed)) *
          100;
        if (apr > 0 && apr < 20) aprs.push(apr); // sanity bounds: 0–20% APR for ETH staking
      }

      if (aprs.length === 0) {
        logger.warn('[Lido] No valid positive rebase events — using fallback APR');
        return 4.0;
      }

      const avg = aprs.reduce((a, b) => a + b, 0) / aprs.length;
      logger.info(`[Lido] APR from ${aprs.length} events: avg=${avg.toFixed(4)}%`);
      return avg;
    } catch (err) {
      logger.warn('[Lido] Could not calculate APR from rebase events, using fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 4.0;
    }
  }

  // ---------------------------------------------------------------------------
  // ETH price from Chainlink
  // ---------------------------------------------------------------------------

  private async getEthPrice(provider: ethers.JsonRpcProvider): Promise<number> {
    try {
      const feed = new ethers.Contract(ETH_USD_FEED, AGGREGATOR_V3_ABI, provider);
      const [, answer] = await withRetry(
        () => feed.latestRoundData(),
        {},
        'lido/ethUsdPrice'
      ) as readonly [unknown, bigint, ...unknown[]];
      return Number(answer) / 1e8;
    } catch (err) {
      logger.warn('[Lido] Could not fetch ETH price', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 3000; // fallback
    }
  }
}
