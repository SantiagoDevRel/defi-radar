/**
 * Express API routes.
 *
 * All routes are read-only GET endpoints (public).
 * The POST /api/refresh endpoint requires an API key when one is configured.
 *
 * Endpoints:
 *   GET  /api/health                — service health + DB stats
 *   GET  /api/yields                — all pools (sorted by APY)
 *   GET  /api/yields/chain/:chain   — pools filtered by chain
 *   GET  /api/yields/token/:symbol  — pools containing a token
 *   GET  /api/yields/:id            — single pool by ID
 *   GET  /api/yields/:id/history    — APY/TVL history for a pool
 *   GET  /api/whitelist             — current token whitelist
 *   GET  /api/protocols             — protocol registry
 *   POST /api/refresh               — trigger manual refresh (API key required)
 *   GET  /api/refresh/status        — current refresh status
 */

import { Router, Request, Response } from 'express';
import {
  getAllPools,
  getPoolsByChain,
  getPoolsByToken,
  getPoolById,
  getPoolHistory,
  getDbStats,
} from '../db/queries';
import { requireApiKey } from './middleware';
import { refreshManager } from '../services/refresh-manager';
import ALL_TOKENS from '../config/whitelist';
import PROTOCOLS from '../config/protocols';
import type { Chain } from '../config/chains';
import { formatYield } from '../utils/format';
import { logger } from '../utils/logger';

const router = Router();

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

router.get('/health', (_req: Request, res: Response) => {
  try {
    const dbStats = getDbStats();
    const refreshProgress = refreshManager.getProgress();

    res.json({
      status: 'ok',
      version: '1.0.0',
      uptime: Math.floor(process.uptime()),
      db: dbStats,
      refresh: {
        status: refreshProgress.status,
        lastCompletedAt: refreshProgress.completedAt,
        lastDurationMs: refreshProgress.lastDurationMs,
        poolCount: refreshProgress.poolCount,
        autoRefreshEnabled: refreshManager.isAutoRefreshEnabled(),
      },
    });
  } catch (err) {
    logger.error('/health error', { error: err });
    res.status(500).json({ status: 'error', error: 'DB unavailable' });
  }
});

// ---------------------------------------------------------------------------
// Yields
// ---------------------------------------------------------------------------

/** GET /api/yields — all pools */
router.get('/yields', (_req: Request, res: Response) => {
  try {
    const pools = getAllPools();
    res.json({
      count: pools.length,
      pools: pools.map(formatYield),
    });
  } catch (err) {
    logger.error('/yields error', { error: err });
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

/** GET /api/yields/chain/:chain — filter by chain */
router.get('/yields/chain/:chain', (req: Request, res: Response) => {
  try {
    const chain = req.params['chain'] as Chain;
    const pools = getPoolsByChain(chain);
    res.json({
      chain,
      count: pools.length,
      pools: pools.map(formatYield),
    });
  } catch (err) {
    logger.error('/yields/chain error', { error: err });
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

/** GET /api/yields/token/:symbol — filter by token symbol */
router.get('/yields/token/:symbol', (req: Request, res: Response) => {
  try {
    const symbol = (req.params['symbol'] as string).toUpperCase();
    const pools = getPoolsByToken(symbol);
    res.json({
      token: symbol,
      count: pools.length,
      pools: pools.map(formatYield),
    });
  } catch (err) {
    logger.error('/yields/token error', { error: err });
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

/** GET /api/yields/:id/history — APY history for a pool */
router.get('/yields/:id/history', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const days = Math.min(
      parseInt((req.query['days'] as string | undefined) ?? '30', 10),
      90
    );

    const pool = getPoolById(id);
    if (!pool) {
      res.status(404).json({ error: `Pool "${id}" not found` });
      return;
    }

    const history = getPoolHistory(id, days);
    res.json({ poolId: id, days, points: history.length, history });
  } catch (err) {
    logger.error('/yields/:id/history error', { error: err });
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/** GET /api/yields/:id — single pool */
router.get('/yields/:id', (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const pool = getPoolById(id);
    if (!pool) {
      res.status(404).json({ error: `Pool "${id}" not found` });
      return;
    }
    res.json(formatYield(pool));
  } catch (err) {
    logger.error('/yields/:id error', { error: err });
    res.status(500).json({ error: 'Failed to fetch pool' });
  }
});

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------

router.get('/whitelist', (_req: Request, res: Response) => {
  res.json({
    count: ALL_TOKENS.length,
    tokens: ALL_TOKENS,
  });
});

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

router.get('/protocols', (_req: Request, res: Response) => {
  res.json({
    count: Object.keys(PROTOCOLS).length,
    protocols: PROTOCOLS,
  });
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** GET /api/refresh/status — current refresh progress */
router.get('/refresh/status', (_req: Request, res: Response) => {
  res.json(refreshManager.getProgress());
});

/** POST /api/refresh — trigger a manual refresh */
router.post('/refresh', requireApiKey, async (req: Request, res: Response) => {
  try {
    // Kick off refresh asynchronously; return immediately with 202
    const chains = req.body?.chains as Chain[] | undefined;
    const protocol = req.body?.protocol as string | undefined;

    logger.info('[API] Manual refresh triggered', { chains, protocol });

    // Don't await — respond 202 immediately and let refresh run in background
    void refreshManager.refresh({ chains, protocol });

    res.status(202).json({
      message: 'Refresh started',
      status: refreshManager.getProgress(),
    });
  } catch (err) {
    logger.error('/refresh error', { error: err });
    res.status(500).json({ error: 'Failed to start refresh' });
  }
});

export default router;
