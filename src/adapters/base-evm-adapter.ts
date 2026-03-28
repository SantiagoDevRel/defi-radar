/**
 * BaseEvmAdapter — shared logic for all EVM-chain protocol adapters.
 *
 * Provides:
 * - Cached ethers.js JsonRpcProvider creation (one provider per chain).
 * - Exponential-backoff retry for any async call.
 * - Typed multicall helper (sequential fallback when Multicall3 is unavailable).
 * - Structured error classification (rate-limit, network, contract revert, etc.).
 */

import { ethers } from 'ethers';
import CHAINS, { type Chain, type EvmChainConfig } from '../config/chains';
import type { ProtocolAdapter, YieldPool } from './types';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Provider cache — one provider per chain URL to avoid socket exhaustion
// ---------------------------------------------------------------------------

const providerCache = new Map<string, ethers.JsonRpcProvider>();

export function getProvider(chain: Chain): ethers.JsonRpcProvider {
  const config = CHAINS[chain];
  if (config.type !== 'evm') {
    throw new Error(`Chain "${chain}" is not an EVM chain`);
  }

  const { rpcUrl, chainId } = config as EvmChainConfig;
  const cacheKey = `${rpcUrl}:${chainId}`;

  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: ethers.Network.from(chainId),
    polling: false,
    // Disable JSON-RPC batching — public nodes (BSC dataseed, Alchemy demo) rate-limit
    // aggressively when multiple eth_calls arrive in a single batch request.
    batchMaxCount: 1,
  });

  providerCache.set(cacheKey, provider);
  logger.debug(`Created provider for chain=${chain} rpc=${rpcUrl}`);
  return provider;
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** If true, also retry on ethers contract call reverts */
  retryOnRevert?: boolean;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15_000,
  retryOnRevert: false,
};

function isRetryableError(err: unknown, retryOnRevert: boolean): boolean {
  if (!(err instanceof Error)) return true;

  const msg = err.message.toLowerCase();

  // Rate limit / server errors — always retry
  if (msg.includes('429') || msg.includes('rate limit')) return true;
  if (msg.includes('503') || msg.includes('502')) return true;
  if (msg.includes('timeout') || msg.includes('etimedout')) return true;
  if (msg.includes('network') || msg.includes('econnreset')) return true;

  // Contract reverts — retry only if explicitly requested
  if (msg.includes('revert') || msg.includes('call exception')) {
    return retryOnRevert;
  }

  return true;
}

/**
 * Wraps an async operation with exponential backoff retry.
 *
 * @example
 * const result = await withRetry(() => contract.getReserveData(asset), { maxAttempts: 4 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  context = 'unknown'
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;

      if (
        attempt >= opts.maxAttempts ||
        !isRetryableError(err, opts.retryOnRevert)
      ) {
        logger.error(`[retry] Giving up after ${attempt} attempts — ${context}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt - 1),
        opts.maxDelayMs
      );

      logger.warn(
        `[retry] Attempt ${attempt}/${opts.maxAttempts} failed for ${context}. Retrying in ${delay}ms`,
        { error: err instanceof Error ? err.message : String(err) }
      );

      await sleep(delay);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ABI fragments reused across adapters
// ---------------------------------------------------------------------------

/** Minimal Chainlink AggregatorV3 ABI */
export const AGGREGATOR_V3_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
  'function description() external view returns (string)',
] as const;

/** Minimal ERC-20 ABI */
export const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function totalSupply() external view returns (uint256)',
  'function balanceOf(address) external view returns (uint256)',
] as const;

// ---------------------------------------------------------------------------
// BaseEvmAdapter class
// ---------------------------------------------------------------------------

/**
 * Abstract base class for EVM protocol adapters.
 *
 * Subclasses implement `fetchPools()` and use `this.provider` / `this.withRetry`.
 */
export abstract class BaseEvmAdapter implements ProtocolAdapter {
  abstract readonly name: string;
  abstract readonly chains: readonly Chain[];

  protected readonly chain: Chain;
  protected readonly provider: ethers.JsonRpcProvider;

  constructor(chain: Chain) {
    this.chain = chain;
    this.provider = getProvider(chain);
  }

  abstract fetchPools(): Promise<YieldPool[]>;

  /**
   * Convenience wrapper: retry a contract call with adapter context.
   */
  protected async withRetry<T>(
    fn: () => Promise<T>,
    context: string,
    options?: RetryOptions
  ): Promise<T> {
    return withRetry(fn, options, `${this.name}/${context}`);
  }

  /**
   * Create a typed contract instance.
   */
  protected contract<T extends ethers.Contract = ethers.Contract>(
    address: string,
    abi: ethers.InterfaceAbi
  ): T {
    return new ethers.Contract(address, abi, this.provider) as T;
  }

  /**
   * Safe multicall: run a list of calls, return results (null on failure).
   * Useful when a single revert shouldn't kill the entire fetch.
   */
  protected async safeMulticall<T>(
    calls: Array<() => Promise<T>>,
    context: string
  ): Promise<Array<T | null>> {
    return Promise.all(
      calls.map(async (call, i) => {
        try {
          return await this.withRetry(call, `${context}[${i}]`, {
            maxAttempts: 2,
          });
        } catch {
          return null;
        }
      })
    );
  }
}
