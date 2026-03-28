/**
 * Refresh Manager — controls when and how data is refreshed.
 *
 * DeFi Radar uses MANUAL refresh by default to avoid hammering public RPCs.
 * An optional auto-refresh timer can be enabled via settings (default OFF).
 *
 * Refresh targets:
 *   - "all"         → run all adapters
 *   - chain filter  → run adapters that support the specified chain(s)
 *   - protocol      → run a single named adapter
 *
 * The manager emits progress events so the API can stream SSE to the client.
 */

import EventEmitter from 'events';
import { YieldAggregator, type AggregatorRunResult } from './yield-aggregator';
import { saveSnapshot } from '../db/queries';
import type { Chain } from '../config/chains';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefreshStatus = 'idle' | 'running' | 'error';

export interface RefreshProgress {
  status: RefreshStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Milliseconds for the last completed run */
  lastDurationMs: number | null;
  poolCount: number | null;
  errorCount: number | null;
  error?: string;
}

export interface RefreshOptions {
  chains?: Chain[];
  protocol?: string;
  /** If true, skip writing to the database (useful for one-off spot checks) */
  skipPersist?: boolean;
}

// Event names emitted on the EventEmitter
export type RefreshEvent =
  | { type: 'started'; options: RefreshOptions }
  | { type: 'completed'; result: AggregatorRunResult }
  | { type: 'error'; error: string };

// ---------------------------------------------------------------------------
// RefreshManager singleton
// ---------------------------------------------------------------------------

class RefreshManager extends EventEmitter {
  private status: RefreshStatus = 'idle';
  private progress: RefreshProgress = {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    lastDurationMs: null,
    poolCount: null,
    errorCount: null,
  };

  private autoRefreshTimer: NodeJS.Timeout | null = null;
  private readonly aggregator = new YieldAggregator();

  // ---------------------------------------------------------------------------
  // Manual refresh
  // ---------------------------------------------------------------------------

  /**
   * Trigger a refresh. If a refresh is already running, returns immediately
   * with the current status without starting a duplicate run.
   */
  async refresh(options: RefreshOptions = {}): Promise<RefreshProgress> {
    if (this.status === 'running') {
      logger.info('[RefreshManager] Refresh already in progress — skipping');
      return this.progress;
    }

    this.status = 'running';
    const startedAt = new Date();
    this.progress = {
      ...this.progress,
      status: 'running',
      startedAt,
      completedAt: null,
      error: undefined,
    };

    this.emit('refresh', { type: 'started', options } satisfies RefreshEvent);
    logger.info('[RefreshManager] Refresh started', { options });

    try {
      const result = await this.aggregator.run({
        chains: options.chains,
        protocol: options.protocol,
      });

      // Persist to DB
      if (!options.skipPersist) {
        await saveSnapshot(result.pools);
        logger.info(`[RefreshManager] Persisted ${result.pools.length} pools to DB`);
      }

      const completedAt = new Date();
      this.status = 'idle';
      this.progress = {
        status: 'idle',
        startedAt,
        completedAt,
        lastDurationMs: result.totalDurationMs,
        poolCount: result.poolCount,
        errorCount: result.errorCount,
      };

      this.emit('refresh', { type: 'completed', result } satisfies RefreshEvent);
      logger.info(
        `[RefreshManager] Refresh completed: ${result.poolCount} pools in ${result.totalDurationMs}ms`
      );

      return this.progress;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.progress = {
        ...this.progress,
        status: 'error',
        completedAt: new Date(),
        error,
      };

      this.emit('refresh', { type: 'error', error } satisfies RefreshEvent);
      logger.error(`[RefreshManager] Refresh failed: ${error}`);

      // Reset to idle after error so next manual trigger works
      this.status = 'idle';

      return this.progress;
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-refresh (optional, default OFF)
  // ---------------------------------------------------------------------------

  /**
   * Start auto-refresh on a fixed interval.
   * No-op if already running. Clears existing timer first.
   *
   * @param intervalMinutes Refresh interval in minutes (min: 5)
   */
  startAutoRefresh(intervalMinutes: number): void {
    if (intervalMinutes < 5) {
      logger.warn('[RefreshManager] Auto-refresh interval must be >= 5 minutes');
      intervalMinutes = 5;
    }

    this.stopAutoRefresh();

    const intervalMs = intervalMinutes * 60 * 1000;
    logger.info(`[RefreshManager] Auto-refresh enabled every ${intervalMinutes} min`);

    this.autoRefreshTimer = setInterval(() => {
      logger.info('[RefreshManager] Auto-refresh triggered');
      void this.refresh();
    }, intervalMs);

    // Don't block Node.js exit
    this.autoRefreshTimer.unref();
  }

  stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
      logger.info('[RefreshManager] Auto-refresh disabled');
    }
  }

  isAutoRefreshEnabled(): boolean {
    return this.autoRefreshTimer !== null;
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  getProgress(): RefreshProgress {
    return { ...this.progress };
  }

  isRunning(): boolean {
    return this.status === 'running';
  }
}

// Export singleton
export const refreshManager = new RefreshManager();
