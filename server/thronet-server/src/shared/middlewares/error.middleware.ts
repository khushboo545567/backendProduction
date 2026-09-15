/**
 * error.middleware.ts
 * Professional-level error handling middleware for auth-service-phase3-kafka
 * Handles uncaught errors and formats responses
 * Compliant with NIST 800-63B and OWASP guidelines
 */

import type { Request, Response, NextFunction } from 'express';
import LoggerUtil from '../logger.util.js';
import ResponseUtil from '../response.util.js';
import { AuditLog } from '@/shared/models/index.models';

interface CustomError extends Error {
    statusCode?: number;
}

const errorMiddleware = (error: CustomError, req: Request, res: Response, _next: NextFunction): void => {
    const ipAddress = req.ip;
    const userId = (req as any).user?.userId || null;

    // Log error
    LoggerUtil.error('Unhandled error', {
        error: error.message,
        stack: error.stack,
        userId,
        ipAddress,
        path: req.path,
    });

     // Audit log
     AuditLog.logAction({
        userId,
        action: 'UNHANDLED_ERROR',
        ipAddress,
        status: 'FAILED',
        severity: 'HIGH', // ✅ FIX: model only allows LOW | MEDIUM | HIGH — 'CRITICAL' isn't valid
        metadata: new Map(Object.entries({ error: error.message, path: req.path })), // ✅ FIX: metadata is typed as Map, not a plain object
    }).catch((auditError: unknown) =>
        LoggerUtil.error('Audit log failed', { error: (auditError as Error).message })
    );

        // Format response — never leak raw DB error text to the client
        let statusCode = error.statusCode || 500;
        let message = error.message || 'Internal server error';
    
        // MongoDB duplicate key error (E11000)
        if ((error as any).code === 11000) {
            statusCode = 409;
            message = 'This entry already exists. Please edit or delete the existing one instead.';
        }
    
        // Mongoose validation error
        if (error.name === 'ValidationError') {
            statusCode = 400;
            message = 'Invalid data provided. Please check your input and try again.';
        }
    
        // Mongoose CastError (bad ObjectId, bad date, etc.)
        if (error.name === 'CastError') {
            statusCode = 400;
            message = 'Invalid identifier provided.';
        }

    // res.status(statusCode).json(
        ResponseUtil.error(res, message.toString(), statusCode)
    // );
};

export default errorMiddleware;