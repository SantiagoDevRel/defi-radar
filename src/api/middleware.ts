/**
 * Express middleware: CORS, API key auth, request logging, error handling.
 */

import { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const allowedOrigins: string[] = (
  process.env['CORS_ORIGINS'] ?? 'http://localhost:3000,http://localhost:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin "${origin}" not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
  credentials: true,
});

// ---------------------------------------------------------------------------
// API key auth (optional — only active when API_SECRET_KEY is set)
// ---------------------------------------------------------------------------

/**
 * Middleware that requires a valid API key for POST/write endpoints.
 * Read-only GET endpoints are always public.
 *
 * Key is passed via the `X-Api-Key` header.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env['API_SECRET_KEY'];

  // If no key is configured, auth is disabled
  if (!secret) {
    next();
    return;
  }

  const provided = req.headers['x-api-key'];
  if (provided === secret) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
}

// ---------------------------------------------------------------------------
// Request logger
// ---------------------------------------------------------------------------

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`, {
      query: req.query,
      ip: req.ip,
    });
  });
  next();
}

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error('Unhandled error in request handler', {
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env['NODE_ENV'] === 'development' ? err.message : undefined,
  });
}

// ---------------------------------------------------------------------------
// Not found handler
// ---------------------------------------------------------------------------

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}
