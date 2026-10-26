import { Request, Response, NextFunction } from 'express';
import paymentService from '../services/payment.service';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import { logger } from '@/shared/logger.util';

export const createSessionOrder = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const { sessionId, mentorId, availabilityId, slotTime, scheduledAt, timezone } = req.body;
    const order = await paymentService.createSessionOrder(userId, {
      sessionId,
      mentorId,
      availabilityId,
      slotTime,
      scheduledAt,
      timezone,
    });

    ResponseHandler.created(res, 'Payment order created', order);
  } catch (error: any) {
    logger.error('Error creating session payment order:', error);
    next(error);
  }
};

export const createPackageOrder = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const { packageType, mentorId } = req.body;
    const order = await paymentService.createPackageOrder(userId, { packageType, mentorId });

    ResponseHandler.created(res, 'Payment order created', order);
  } catch (error: any) {
    logger.error('Error creating package payment order:', error);
    next(error);
  }
};

export const verifyPayment = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const { paymentId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    const result = await paymentService.verifyAndFulfill(userId, {
      paymentId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    ResponseHandler.success(res, 'Payment verified', result);
  } catch (error: any) {
    logger.error('Error verifying payment:', error);
    next(error);
  }
};

export const getPaymentStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const status = await paymentService.getPaymentStatus(userId, req.params.paymentId);
    ResponseHandler.success(res, 'Payment status retrieved', status);
  } catch (error: any) {
    logger.error('Error getting payment status:', error);
    next(error);
  }
};

/**
 * Razorpay webhook - auth/CSRF nahi, sirf signature. Raw body zaroori hai (app.ts mein verify hook).
 */
export const razorpayWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const signature = req.headers['x-razorpay-signature'] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;

    await paymentService.handleWebhook(rawBody, signature);
    res.status(200).json({ received: true });
  } catch (error: any) {
    logger.error('Razorpay webhook error:', error);
    next(error);
  }
};