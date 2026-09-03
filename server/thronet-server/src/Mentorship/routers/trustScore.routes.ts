import express, { Request, Response, NextFunction } from 'express';
import TrustScoreController from '@/Mentorship/controllers/trustScore.controller';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import rateLimitMiddleware from '@/shared/middlewares/rateLimit.middleware';

const router = express.Router();

/**
 * @route   GET /api/v1/mentorship/trust-score/:userId
 * @desc    Get a user's mentor trust score (returns isMentor:false if not a mentor)
 * @access  Private
 */
router.get(
    '/trust-score/:userId',
    AuthMiddleware.authenticate as any,
    rateLimitMiddleware({ maxRequests: 60, windowMs: 60000 }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            await TrustScoreController.getTrustScoreByUserId(req as any, res);
        } catch (error: any) {
            next(error);
        }
    }
);

export default router;