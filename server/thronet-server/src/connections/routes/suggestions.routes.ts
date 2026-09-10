// src/connections/routes/suggestions.routes.ts
//
// Resolves to: /api/v1/connections/suggestions
//   GET  /          – paginated PYMK suggestion list (offset-based)
//   DELETE /:targetUserId – persist-dismiss a suggestion (never resurfaces)
//   POST /trigger-cron    – DEV/TEST only: fire notifyPymk for a given userId
//                          bypassing the 7-day PymkNotificationState gate

import { Router, Request, Response } from 'express';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import { createRateLimiter } from '../middleware/rateLimiter.middleware';
import { asyncHandler } from '../middleware/asyns.middleware';
import ConnectionService from '../services/connection.service';
import { ErrorResponse, HttpStatus } from '@/shared/response.util';
import environmentConfig from '@/config/environment/environment';

const router = Router();

// ── Rate limiters ────────────────────────────────────────────────────────────
const suggestionsReadLimiter = createRateLimiter({
    storePrefix: 'suggestions_read',
    windowMs: 60 * 1000,           // 1 minute
    max: 60,                        // 60 reads/min per user – same as healthCheck limiter
    message: 'Too many suggestion requests, please slow down',
});

const dismissLimiter = createRateLimiter({
    storePrefix: 'suggestions_dismiss',
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many dismiss requests, please slow down',
});

// ── Auth (same pattern as request.routes.ts line 81) ────────────────────────
router.use(AuthMiddleware.authenticate as any);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/connections/suggestions
//   Query params:
//     limit  – number of cards to return (default 20, max 50)
//     offset – zero-based skip count for pagination (default 0)
// ────────────────────────────────────────────────────────────────────────────
router.get(
    '/',
    suggestionsReadLimiter,
    asyncHandler(async (req: Request, res: Response) => {
        const userId: string = (req as any).user?.userId || (req as any).user?.id;
        if (!userId) {
            throw new ErrorResponse('Unauthorized', HttpStatus.UNAUTHORIZED);
        }

        const limit = Math.min(
            parseInt(String(req.query.limit || '20'), 10),
            50                          // hard cap – never more than 50 per page
        );
        const offset = Math.max(parseInt(String(req.query.offset || '0'), 10), 0);

        // processConnectionRecommendations returns string[] of userIds;
        // getSuggestionCards then decorates them with profile data.
        // We call getSuggestionCards here so the page gets ready-to-render cards.
        const { getSuggestionCards } = await import('../services/network.service');
        const cards = await getSuggestionCards(userId, limit, String(offset));

        res.status(HttpStatus.OK).json({
            success: true,
            data: cards,
            pagination: {
                offset,
                limit,
                returned: cards.length,
                hasMore: cards.length === limit,
            },
        });
    })
);

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/connections/suggestions/:targetUserId
//   Persists the dismissal to User.dismissedSuggestionIds and
//   invalidates the recommendation cache (both cacheKey and poolKey).
// ────────────────────────────────────────────────────────────────────────────
router.delete(
    '/:targetUserId',
    dismissLimiter,
    asyncHandler(async (req: Request, res: Response) => {
        const userId: string = (req as any).user?.userId || (req as any).user?.id;
        if (!userId) {
            throw new ErrorResponse('Unauthorized', HttpStatus.UNAUTHORIZED);
        }

        const { targetUserId } = req.params;
        if (!targetUserId || typeof targetUserId !== 'string') {
            throw new ErrorResponse('targetUserId is required', HttpStatus.BAD_REQUEST);
        }
        if (targetUserId === userId) {
            throw new ErrorResponse('Cannot dismiss yourself', HttpStatus.BAD_REQUEST);
        }

        await ConnectionService.dismissSuggestion(userId, targetUserId);

        res.status(HttpStatus.OK).json({
            success: true,
            message: 'Suggestion dismissed',
        });
    })
);

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/connections/suggestions/trigger-cron
//   DEV / TEST ONLY – bypasses the 7-day PymkNotificationState gate and
//   fires notifyPymk() directly for a given userId.
//   Returns 403 in production so this can never be hit by accident.
// ────────────────────────────────────────────────────────────────────────────
router.post(
    '/trigger-cron',
    asyncHandler(async (req: Request, res: Response) => {
        if (environmentConfig.NODE_ENV === 'production') {
            throw new ErrorResponse(
                'This endpoint is only available in development/test environments',
                HttpStatus.FORBIDDEN
            );
        }

        const { userId } = req.body as { userId?: string };
        if (!userId) {
            throw new ErrorResponse('userId is required in request body', HttpStatus.BAD_REQUEST);
        }

        // Dynamic import to avoid circular dep (same reason as pymkSuggestionCron.ts line 125)
        const { getSuggestionCards } = await import('../services/network.service');
        const NotificationService = (await import('@/notifications/services/notification.service')).default;

        const suggestions = await getSuggestionCards(userId, 10);
        if (!suggestions || suggestions.length === 0) {
            return res.status(HttpStatus.OK).json({
                success: false,
                message: 'No suggestions found for this user — cannot trigger PYMK notification',
            });
        }

        await NotificationService.notifyPymk(userId, suggestions);

        res.status(HttpStatus.OK).json({
            success: true,
            message: `PYMK notification fired for userId=${userId}`,
            suggestionCount: suggestions.length,
        });
    })
);

export default router;
