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

    const provider = getProvider('ethereum');

    // Get ETH price from Chainlink
    const ethPriceUsd = await this.getEthPrice(provider);
    logger.info(`[Lido] ETH price: $${ethPriceUsd.toFixed(2)}`);

    // Get stETH total supply for TVL
    const steth = new ethers.Contract(STETH_ADDRESS, STETH_ABI, provider);
    const totalSupply: bigint = await withRetry(
      () => steth.totalSupply(),
      {},
      'lido/totalSupply'
    );
    const tvlUsd = (Number(totalSupply) / 1e18) * ethPriceUsd;

    // Get recent TokenRebased events to calculate APY
    const apyBase = await this.calculateApyFromRebases(steth, provider);
    logger.info(`[Lido] stETH APY: ${apyBase.toFixed(4)}%  TVL: $${(tvlUsd / 1e9).toFixed(2)}B`);

    const riskScore = calculateRiskScore({
      protocolId: 'lido-finance',
      tvlUsd,
      apyBase,
      apyReward: 0,
      yieldType: 'staking',
    });

    const pool: YieldPool = {
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
      il7d: null, // single asset, no IL
      url: 'https://stake.lido.fi',
      contractAddress: STETH_ADDRESS,
      lastUpdated: new Date(),
    };

    return [pool];
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
      // Scan last 14 days of events to ensure we get at least one rebase
      const fromBlock = currentBlock - BLOCKS_PER_DAY_ETH * 14;

      logger.debug(`[Lido] Querying TokenRebased events from block ${fromBlock}`);

      const filter = steth.filters.TokenRebased();
      const events = await withRetry(
        () => steth.queryFilter(filter, fromBlock, currentBlock),
        { maxAttempts: 3 },
        'lido/TokenRebased'
      );

      if (!events || events.length === 0) {
        logger.warn('[Lido] No TokenRebased events found — using fallback APR');
        return 4.0; // reasonable Ethereum staking fallback
      }

      // Use the most recent rebase event for the most current APR
      const latest = events[events.length - 1] as ethers.EventLog;
      // ethers v6 Result is not directly castable — access named fields via unknown
      const latestArgs = latest.args as unknown as {
        timeElapsed: bigint;
        preTotalEther: bigint;
        postTotalEther: bigint;
      };
      const { timeElapsed, preTotalEther, postTotalEther } = latestArgs;

      if (preTotalEther === 0n || timeElapsed === 0n) {
        logger.warn('[Lido] Invalid rebase event data');
        return 4.0;
      }

      // APR = (postTotal - preTotal) / preTotal * (SECONDS_PER_YEAR / timeElapsed)
      const rewardEther = postTotalEther - preTotalEther;
      const apr =
        (Number(rewardEther) / Number(preTotalEther)) *
        (SECONDS_PER_YEAR / Number(timeElapsed)) *
        100;

      // Average over last N events for a smoother estimate
      if (events.length >= 3) {
        const recent = events.slice(-7); // up to last 7 rebase events
        const aprs = recent.map((e) => {
          const ev = e as ethers.EventLog;
          const args = ev.args as unknown as { timeElapsed: bigint; preTotalEther: bigint; postTotalEther: bigint };
          if (args.preTotalEther === 0n || args.timeElapsed === 0n) return 0;
          const reward = args.postTotalEther - args.preTotalEther;
          return (Number(reward) / Number(args.preTotalEther)) * (SECONDS_PER_YEAR / Number(args.timeElapsed)) * 100;
        }).filter((x) => x > 0);

        if (aprs.length > 0) {
          const avg = aprs.reduce((a, b) => a + b, 0) / aprs.length;
          logger.info(`[Lido] APR from ${aprs.length} events: latest=${apr.toFixed(4)}% avg=${avg.toFixed(4)}%`);
          return avg;
        }
      }

      return Math.max(0, apr);
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
