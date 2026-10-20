import { Request, Response, NextFunction } from 'express';
import { SessionType } from '@/shared/constants/sessionTypes';
import { SessionMentor } from '../models';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';

class PublicServicesController {
  /**
   * @route   GET /api/v1/mentorship/sessions/public
   * @desc    Marketplace listing of 1-to-1 services (group sessions excluded).
   *          Bookings, mentee ids, payment and cancellation data are NOT returned.
   * @query   page=1, limit=20 (max 100)
   * @access  Private (any logged-in user)
   */
  async getPublicServices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const skip = (page - 1) * limit;

      const query: any = {
        sessionType: { $ne: SessionType.GROUP_SESSION },
        status: { $nin: ['cancelled', 'no_show', 'refunded', 'completed'] },
      };

      const [sessions, total] = await Promise.all([
        SessionMentor.find(query)
          .select('-bookings -menteeId -bookedBy -bookedAt -payment -cancellation -reschedule')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        SessionMentor.countDocuments(query),
      ]);

      logger.info(`Public services fetched: ${sessions.length} of ${total}`);

      ResponseHandler.paginated(
        res,
        'Services retrieved successfully',
        sessions,
        page,
        limit,
        total
      );
    } catch (error: any) {
      logger.error('Failed to fetch public services:', error);
      next(error);
    }
  }
}

export default new PublicServicesController();