import { Router } from 'express';
import { param } from 'express-validator';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import { validate } from '@/shared/middlewares/validation.middleware';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import { adminList, adminRelease, adminMarkPaid, mentorOverview } from '../controllers/payout.controller';

// Mentor: apni earnings dekhe  ->  GET /mentorship/payouts/mentor/:mentorId
export const mentorPayoutRouter = Router();
mentorPayoutRouter.get('/mentor/:mentorId', AuthMiddleware.authenticate as any, mentorOverview);

// Admin: approve / mark paid  ->  /mentorship/admin/payouts
export const adminPayoutRouter = Router();
adminPayoutRouter.use(AuthMiddleware.authenticate as any);
adminPayoutRouter.use((req, res, next) => {
  if (req.user?.role !== 'admin') return ResponseHandler.forbidden(res, 'Admin access required');
  next();
});

adminPayoutRouter.get('/', adminList);
adminPayoutRouter.post(
  '/:paymentId/release',
  validate([param('paymentId').isUUID().withMessage('Invalid payment ID')]),
  adminRelease
);
adminPayoutRouter.post(
  '/:paymentId/mark-paid',
  validate([param('paymentId').isUUID().withMessage('Invalid payment ID')]),
  adminMarkPaid
);