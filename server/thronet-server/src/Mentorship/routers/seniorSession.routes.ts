import { Router } from 'express';

import SeniorSessionController from '../controllers/seniorSession.controller';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';

import {
  createSeniorSessionValidator,
  updateSeniorSessionValidator,
  seniorSessionIdValidator,
  seniorBookingIdValidator,
} from '../validations/seniorSession.validator';
import { uploadSingle } from '@/shared/upload/upload';

const router = Router();

/**
 * Get all active 1-to-1 Senior Sessions for discovery
 * GET /senior-sessions
 * Public route
 */
router.get(
  '/',
  SeniorSessionController.getDiscoverySessions
);

/**
 * All Senior Session routes require authentication.
 */
router.use(AuthMiddleware.authenticate);

/**
 * Create a Senior Session
 * POST /senior-sessions
 */
router.post(
  '/',
  uploadSingle('thumbnailImage', 'image', false),
  createSeniorSessionValidator,
  SeniorSessionController.createSession
);



/**
 * Get all sessions owned by the authenticated Senior Mentor
 * GET /senior-sessions/my
 */
router.get(
  '/my',
  SeniorSessionController.getMySessions
);

/**
 * Get analytics dashboard metrics for the authenticated Senior Mentor
 * GET /senior-sessions/analytics
 */
router.get(
  '/analytics',
  SeniorSessionController.getAnalytics
);

/**
 * Get a single Senior Session
 * GET /senior-sessions/:sessionId
 */
router.get(
  '/:sessionId',
  seniorSessionIdValidator,
  SeniorSessionController.getSessionById
);

/**
 * Book a Senior Session
 * POST /senior-sessions/:sessionId/book
 */
router.post(
  '/:sessionId/book',
  seniorSessionIdValidator,
  SeniorSessionController.bookSession
);

/**
 * Update a Senior Session
 * PUT /senior-sessions/:sessionId
 */
router.put(
  '/:sessionId',
  uploadSingle('thumbnailImage', 'image', false),
  updateSeniorSessionValidator,
  SeniorSessionController.updateSession
);

/**
 * Cancel a Senior Session
 * DELETE /senior-sessions/:sessionId
 */
router.delete(
  '/:sessionId',
  seniorSessionIdValidator,
  SeniorSessionController.cancelSession
);

/**
 * Confirm/Accept a Senior Booking
 * POST /senior-sessions/:sessionId/bookings/:bookingId/confirm
 */
router.post(
  '/:sessionId/bookings/:bookingId/confirm',
  seniorBookingIdValidator,
  SeniorSessionController.confirmBooking
);

/**
 * Cancel/Reject a Senior Booking
 * POST /senior-sessions/:sessionId/bookings/:bookingId/cancel
 */
router.post(
  '/:sessionId/bookings/:bookingId/cancel',
  seniorBookingIdValidator,
  SeniorSessionController.cancelBooking
);

/**
 * Reschedule a Senior Booking
 * POST /senior-sessions/:sessionId/bookings/:bookingId/reschedule
 */
router.post(
  '/:sessionId/bookings/:bookingId/reschedule',
  seniorBookingIdValidator,
  SeniorSessionController.rescheduleBooking
);

/**
 * Start an Upcoming Senior Booking
 * POST /senior-sessions/:sessionId/bookings/:bookingId/start
 */
router.post(
  '/:sessionId/bookings/:bookingId/start',
  seniorBookingIdValidator,
  SeniorSessionController.startBooking
);

/**
 * Complete an In-Progress Senior Booking
 * POST /senior-sessions/:sessionId/bookings/:bookingId/complete
 */
router.post(
  '/:sessionId/bookings/:bookingId/complete',
  seniorBookingIdValidator,
  SeniorSessionController.completeBooking
);

export default router;