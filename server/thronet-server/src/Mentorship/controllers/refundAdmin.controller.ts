import { Request, Response, NextFunction } from 'express';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import refundAdminService from '../services/refundAdmin.service';

class RefundAdminController {
  /** GET /refunds?status=pending|refunded&page&limit */
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = req.query.status === 'refunded' ? 'refunded' : 'pending';
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

      const { rows, total } = await refundAdminService.listRefunds(status, page, limit);
      ResponseHandler.paginated(res, 'Refunds retrieved successfully', rows, page, limit, total);
    } catch (error: any) {
      logger.error('Failed to list refunds:', error);
      next(error);
    }
  }

  /** POST /refunds/:bookingId/mark-refunded  body: { reference } */
  async markRefunded(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { bookingId } = req.params;
      const reference = String(req.body?.reference || '').trim();
      if (reference.length < 3) {
        ResponseHandler.badRequest(res, 'Transaction reference is required');
        return;
      }
      const adminId = (req.user as any)?.userId || req.user?.id;
      const result = await refundAdminService.markRefunded(bookingId, reference, adminId);
      ResponseHandler.success(res, 'Refund marked as completed', result);
    } catch (error: any) {
      logger.error('Failed to mark refund:', error);
      next(error);
    }
  }
}

export default new RefundAdminController();