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
import { corsMiddleware, requestLogger, errorHandler, notFound } from './api/middleware';
import routes from './api/routes';
import { initDatabase, closeDb } from './db/database';
import { refreshManager } from './services/refresh-manager';
import { logger } from './utils/logger';

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

// Root landing page — quick visual check that the server is alive
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DeFi Radar</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0d1117; color: #e6edf3; min-height: 100vh;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; padding: 2rem; }
    h1 { font-size: 2.4rem; font-weight: 700; margin-bottom: .5rem; }
    h1 span { color: #58a6ff; }
    .subtitle { color: #8b949e; margin-bottom: 2.5rem; font-size: 1rem; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                 gap: 1rem; width: 100%; max-width: 860px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
            padding: 1.25rem 1.5rem; }
    .card h2 { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em;
               color: #8b949e; margin-bottom: .6rem; }
    .card a { display: block; color: #58a6ff; text-decoration: none; font-size: .9rem;
              padding: .25rem 0; border-bottom: 1px solid #21262d; }
    .card a:last-child { border-bottom: none; }
    .card a:hover { color: #79c0ff; }
    .badge { display: inline-block; background: #238636; color: #fff; font-size: .7rem;
             padding: .15rem .5rem; border-radius: 999px; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>⚡ DeFi <span>Radar</span></h1>
  <p class="subtitle">100% on-chain yield dashboard — no third-party APIs</p>

  <div class="card-grid">
    <div class="card">
      <h2>Yields</h2>
      <a href="/api/yields">/api/yields</a>
      <a href="/api/yields/chain/bnb">/api/yields/chain/bnb</a>
      <a href="/api/yields/token/USDC">/api/yields/token/USDC</a>
      <a href="/api/yields/token/BTC">/api/yields/token/BTC</a>
    </div>
    <div class="card">
      <h2>System</h2>
      <a href="/api/health">/api/health</a>
      <a href="/api/refresh/status">/api/refresh/status</a>
      <a href="/api/whitelist">/api/whitelist</a>
      <a href="/api/protocols">/api/protocols</a>
    </div>
    <div class="card">
      <h2>Status</h2>
      <a href="https://github.com/SantiagoDevRel/defi-radar" target="_blank">GitHub ↗</a>
      <span class="badge">Sprint 1 — Venus Live</span>
    </div>
  </div>
</body>
</html>`);
});

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

  // Initialize DB (async WASM load + schema migration)
  try {
    await initDatabase();
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
