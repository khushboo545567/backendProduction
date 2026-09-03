import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { TrustScoreService } from '@/Mentorship/services/trustScore.service';
import ResponseUtil from '@/shared/response.util';
import { LoggerUtil } from '@/shared/logger.util';

interface UserPayload {
    userId: string;
    role: string;
    email: string;
}

class TrustScoreController {

    /**
     * ✅ GET TRUST SCORE BY USER ID
     * Profile page pe visitor ya owner dono ke liye — koi bhi authenticated
     * user kisi bhi userId ka trust score dekh sakta hai (public profile info hai).
     */
    static async getTrustScoreByUserId(
        req: Request<{ userId: string }> & { user?: UserPayload },
        res: Response
    ): Promise<void> {
        const correlationId = (req as any).correlationId || uuidv4();

        try {
            if (!req.user?.userId) {
                ResponseUtil.unauthorized(res, 'Authentication required');
                return;
            }

            const { userId } = req.params;

            if (!userId) {
                ResponseUtil.badRequest(res, 'User ID is required');
                return;
            }

            const trustScoreData = await TrustScoreService.getByUserId(userId);

            if (!trustScoreData) {
                // User mentor nahi hai — error nahi, bas empty state
                ResponseUtil.success(
                    res,
                    { isMentor: false, trustScore: null },
                    'User is not a mentor'
                );
                return;
            }

            ResponseUtil.success(
                res,
                { isMentor: true, ...trustScoreData },
                'Trust score fetched successfully'
            );
            return;

        } catch (error: any) {
            LoggerUtil.error('Get trust score failed', {
                error: error.message,
                userId: req.params.userId,
                correlationId,
            });

            ResponseUtil.internalError(res, error.message, error);
            return;
        }
    }
}

export default TrustScoreController;