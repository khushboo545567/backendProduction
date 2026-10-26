import express from 'express';
import { body, param } from 'express-validator';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import { validate } from '@/shared/middlewares/validation.middleware';
import {
  createSessionOrder,
  createPackageOrder,
  verifyPayment,
  getPaymentStatus,
  razorpayWebhook,
} from '../controllers/payment.controller';

const router = express.Router();

// Public (signature se protected)
router.post('/webhook', razorpayWebhook);

router.post(
  '/session/order',
  AuthMiddleware.authenticate as any,
  validate([
    body('sessionId').isString().notEmpty().withMessage('sessionId is required'),
    body('mentorId').isString().notEmpty().withMessage('mentorId is required'),
    body('availabilityId').isString().notEmpty().withMessage('availabilityId is required'),
    body('slotTime').isString().notEmpty().withMessage('slotTime is required'),
    body('scheduledAt').isISO8601().withMessage('Invalid scheduledAt'),
    body('timezone').isString().notEmpty().withMessage('timezone is required'),
  ]),
  createSessionOrder
);

router.post(
  '/package/order',
  AuthMiddleware.authenticate as any,
  validate([
    body('packageType').isIn(['starter', 'professional', 'premium']).withMessage('Invalid package type'),
    body('mentorId').optional().isString().withMessage('Invalid mentor ID'),
  ]),
  createPackageOrder
);

router.post(
  '/verify',
  AuthMiddleware.authenticate as any,
  validate([
    body('paymentId').isUUID().withMessage('Invalid payment ID'),
    body('razorpayOrderId').isString().notEmpty(),
    body('razorpayPaymentId').isString().notEmpty(),
    body('razorpaySignature').isString().notEmpty(),
  ]),
  verifyPayment
);

router.get(
  '/:paymentId',
  AuthMiddleware.authenticate as any,
  validate([param('paymentId').isUUID().withMessage('Invalid payment ID')]),
  getPaymentStatus
);

export default router;