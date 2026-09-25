// src/Mentorship/controllers/community.controller.ts
import { Response, NextFunction } from 'express';
import { AuthRequest } from '@/shared/middlewares/auth.middleware';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import communityService from '@/Mentorship/services/community.service';

class CommunityController {
  async getTopMentors(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const period = (req.query.period as 'weekly' | 'monthly' | 'all-time') || 'all-time';
      const domain = req.query.domain as string | undefined;

      const topMentors = await communityService.getTopMentors(limit, period, domain);
      ResponseHandler.success(res, 'Top mentors fetched successfully', topMentors);
    } catch (error: any) {
      logger.error('Error fetching top mentors:', error);
      next(error);
    }
  }

  async getCommunityStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const stats = await communityService.getCommunityStats();
      ResponseHandler.success(res, 'Community stats fetched successfully', stats);
    } catch (error: any) {
      logger.error('Error fetching community stats:', error);
      next(error);
    }
  }
}

export default new CommunityController();
