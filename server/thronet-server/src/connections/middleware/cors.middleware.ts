// src/connections/middleware/cors.middleware.ts

import cors from 'cors';
import { Request, Response, NextFunction } from 'express';
import environmentConfig from '@/config/environment/environment';
import { LoggerUtil as logger } from '@/shared/logger.util';
import { ErrorResponse } from '@/shared/response.util';

/**
 * CORS Middleware
 * Dynamic origin whitelist from CORS_ALLOWED_ORIGINS (comma separated).
 * Use '*' to allow all origins (not recommended with credentials in production).
 */

const allowedOrigins = new Set(
  (environmentConfig.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin: string) => origin.trim())
    .filter(Boolean)
);

export const corsMiddleware = cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.has('*') || allowedOrigins.has(origin)) {
      return callback(null, true);
    }

    logger.warn('Invalid CORS origin', { origin });
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-ID', 'X-CSRF-Token'],
  exposedHeaders: ['X-Request-ID', 'Authorization', 'Content-Length', 'X-CSRF-Token'],
  maxAge: 86400,
  preflightContinue: false,
});

export const corsErrorHandler = (err: Error, req: Request, res: Response, next: NextFunction): void => {
  if (err.message === 'Not allowed by CORS') {
    logger.error('CORS policy violation', {
      origin: req.get('origin'),
      url: req.originalUrl,
    });
    res.status(403).json(
      new ErrorResponse('CORS policy violation', 403, 'CORS_VIOLATION', {
        origin: req.get('origin'),
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }
  next(err);
};

export const isOriginAllowed = (origin: string | undefined): boolean => {
  return !origin || allowedOrigins.has('*') || allowedOrigins.has(origin);
};

export default { corsMiddleware, corsErrorHandler, isOriginAllowed };