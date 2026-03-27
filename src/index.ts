/**
 * DeFi Radar — Express server entry point.
 *
 * Startup sequence:
 * 1. Load environment variables from .env
 * 2. Initialize the SQLite database (run migrations)
 * 3. Mount API routes
 * 4. Start listening
 * 5. Optionally enable auto-refresh if AUTO_REFRESH_INTERVAL_MINUTES > 0
 */

import 'dotenv/config';
import express from 'express';
import { corsMiddleware, requestLogger, errorHandler, notFound } from './api/middleware.js';
import routes from './api/routes.js';
import { getDb, closeDb } from './db/database.js';
import { refreshManager } from './services/refresh-manager.js';
import { logger } from './utils/logger.js';

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

// Trust Railway/Render proxy headers
app.set('trust proxy', 1);

// Body parsing
app.use(express.json());

// CORS
app.use(corsMiddleware);

// Request logging
app.use(requestLogger);

// API routes (all under /api)
app.use('/api', routes);

// 404 + error handlers (must be last)
app.use(notFound);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  const port = parseInt(process.env['PORT'] ?? '3001', 10);

  // Initialize DB (creates schema if not exists)
  try {
    getDb();
    logger.info('[Startup] Database initialized');
  } catch (err) {
    logger.error('[Startup] Failed to initialize database', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Optional auto-refresh
  const autoRefreshMinutes = parseInt(
    process.env['AUTO_REFRESH_INTERVAL_MINUTES'] ?? '0',
    10
  );
  if (autoRefreshMinutes > 0) {
    refreshManager.startAutoRefresh(autoRefreshMinutes);
    logger.info(`[Startup] Auto-refresh enabled: every ${autoRefreshMinutes} min`);
  } else {
    logger.info('[Startup] Auto-refresh disabled (manual refresh only)');
  }

  // Start server
  app.listen(port, () => {
    logger.info(`[Startup] DeFi Radar running on http://localhost:${port}`);
    logger.info(`[Startup] API docs: http://localhost:${port}/api/health`);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  logger.info(`[Shutdown] Received ${signal}, shutting down gracefully`);
  refreshManager.stopAutoRefresh();
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Handle unhandled promise rejections (e.g. from fire-and-forget refreshes)
process.on('unhandledRejection', (reason) => {
  logger.error('[Process] Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

start().catch((err) => {
  logger.error('[Startup] Fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
