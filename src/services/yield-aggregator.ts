/**
 * Yield Aggregator — orchestrates all protocol adapters.
 *
 * Responsibilities:
 * - Runs all registered adapters (or a subset by chain/protocol).
 * - Normalizes and deduplicates results.
 * - Applies the global TVL filter (MIN_TVL_USD env var, default $100k).
 * - Sorts by total APY descending.
 * - Returns timing and error metadata per adapter.
 */

import type { ProtocolAdapter, YieldPool, AdapterResult } from '../adapters/types.js';
import { VenusAdapter } from '../adapters/venus.js';
import type { Chain } from '../config/chains.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Adapter registry — add new adapters here
// ---------------------------------------------------------------------------

function buildAdapterRegistry(): ProtocolAdapter[] {
  return [
    new VenusAdapter(),
    // Future adapters:
    // new AaveAdapter('ethereum'),
    // new AaveAdapter('polygon'),
    // new CompoundAdapter('ethereum'),
    // new PancakeSwapAdapter(),
    // new OrcaAdapter(),
    // new MarinadeAdapter(),
    // new BlendAdapter(),
  ];
}

// ---------------------------------------------------------------------------
// Aggregator class
// ---------------------------------------------------------------------------

export interface AggregatorOptions {
  /** Only run adapters that support at least one of these chains */
  chains?: Chain[];
  /** Only run the adapter with this name */
  protocol?: string;
  /** Minimum TVL filter (USD). Defaults to MIN_TVL_USD env var or 100_000 */
  minTvlUsd?: number;
}

export interface AggregatorRunResult {
  pools: YieldPool[];
  adapterResults: AdapterResult[];
  totalDurationMs: number;
  poolCount: number;
  errorCount: number;
}

export class YieldAggregator {
  private readonly adapters: ProtocolAdapter[];
  private readonly minTvlUsd: number;

  constructor() {
    this.adapters = buildAdapterRegistry();
    this.minTvlUsd = parseInt(process.env['MIN_TVL_USD'] ?? '100000', 10);
  }

  /**
   * Run all adapters (filtered by options) and return normalized pools.
   */
  async run(options: AggregatorOptions = {}): Promise<AggregatorRunResult> {
    const startTime = Date.now();

    // Filter adapters
    let adapters = this.adapters;

    if (options.protocol) {
      adapters = adapters.filter((a) => a.name === options.protocol);
    }
    if (options.chains && options.chains.length > 0) {
      const chainSet = new Set<Chain>(options.chains);
      adapters = adapters.filter((a) =>
        a.chains.some((c) => chainSet.has(c))
      );
    }

    logger.info(`[Aggregator] Running ${adapters.length} adapter(s)`);

    // Run all adapters in parallel
    const adapterResults = await Promise.all(
      adapters.map((adapter) => this.runAdapter(adapter))
    );

    // Flatten all pools
    const allPools = adapterResults.flatMap((r) => r.pools);

    // Apply TVL filter
    const minTvl = options.minTvlUsd ?? this.minTvlUsd;
    const filtered = allPools.filter((p) => p.tvlUsd >= minTvl);

    // Sort by total APY descending
    filtered.sort((a, b) => b.apyTotal - a.apyTotal);

    const totalDurationMs = Date.now() - startTime;
    const errorCount = adapterResults.filter((r) => r.error !== undefined).length;

    logger.info(
      `[Aggregator] Done: ${filtered.length} pools from ${adapters.length} adapters in ${totalDurationMs}ms (${errorCount} errors)`
    );

    return {
      pools: filtered,
      adapterResults,
      totalDurationMs,
      poolCount: filtered.length,
      errorCount,
    };
  }

  private async runAdapter(adapter: ProtocolAdapter): Promise<AdapterResult> {
    const start = Date.now();
    try {
      logger.info(`[Aggregator] Running adapter: ${adapter.name}`);
      const pools = await adapter.fetchPools();
      const durationMs = Date.now() - start;
      logger.info(
        `[Aggregator] ${adapter.name}: ${pools.length} pools in ${durationMs}ms`
      );
      return { adapterName: adapter.name, pools, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`[Aggregator] ${adapter.name} failed: ${error}`);
      return { adapterName: adapter.name, pools: [], error, durationMs };
    }
  }

  /** List all registered adapter names */
  getAdapterNames(): string[] {
    return this.adapters.map((a) => a.name);
  }
}
