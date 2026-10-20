import { Router } from 'express';
import { sessionController } from '../controllers';
import publicServicesController from '../controllers/publicServices.controller';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import { validateJoi } from '@/shared/middlewares/validation.middleware';
import sessionValidator from '../validations/session.validator';
import { uploadSingle } from '@/shared/upload/upload';
import { NextFunction, Request, Response } from 'express';

const router = Router();

const parseFormDataFields = (req: Request, res: Response, next: NextFunction): void => {
  const fieldsToParse = ['pricing', 'followUp', 'meeting', 'settings'];
  for (const field of fieldsToParse) {
    const body = req.body as Record<string, any>;
    if (body[field] && typeof body[field] === 'string') {
      try {
        body[field] = JSON.parse(body[field]);
      } catch (e) {
        // ignore
      }
    }
  }
  next();
};

/**
 * @route   GET /api/v1/mentorship/sessions/public
 * @desc    Marketplace listing: 1-to-1 services (bookings/mentee data hidden)
 * @query   page=1, limit=20
 * @access  Public (no login needed; sensitive fields are stripped in controller)
 * NOTE: authenticate middleware se pehle aur /:id se pehle hona zaroori hai.
 */
router.get('/public', publicServicesController.getPublicServices);

// All routes below require authentication
router.use(AuthMiddleware.authenticate as any);

// ============================================================
// COLLECTION ROUTES (specific paths - /:id se pehle hone chahiye)
// ============================================================

/**
 * @route   POST /api/v1/sessions/create
 * @desc    Naya session assign hoga (mentor karta hai)
 * @access  Private (Mentor)
 */
router.post(
  '/create',
  uploadSingle('thumbnailImage', 'image', false),
  parseFormDataFields,
  validateJoi(sessionValidator.createSession),
  sessionController.createSession
);

/**
 * @route   GET /api/v1/mentorship/sessions/mentor/:mentorId
 * @desc    Mentor ke saare assigned sessions (user ke profile page ke liye)
 * @access  Public
 */
router.get(
  '/mentor/:mentorId',
  sessionController.getMentorAssignedSessions
);

/**
 * @route   GET /api/v1/sessions/get-all-db
 * @desc    DB me stored saare sessions lo (all users ke)
 * @query   page=1, limit=10
 * @access  Private
 * WARNING: ye bookings (mentee ids) bhi return karta hai. Public listing ke
 * liye /public use karo.
 */
router.get('/get-all-db', sessionController.getAllSessionsFromDB);

/**
 * @route   GET /api/v1/sessions/get-all
 * @desc    Current user ke saare sessions lo (mentor ya mentee dono ke liye)
 * @query   role=mentee|mentor, page=1, limit=10, status, sessionType, startDate, endDate
 * @access  Private
 */
router.get('/get-all', sessionController.getAllSessions);

/**
 * @route   GET /api/v1/sessions/upcoming
 * @desc    Current user ke upcoming sessions lo (mentor ya mentee dono ke liye)
 * @query   role=mentee|mentor, limit=10
 * @access  Private
 */
router.get('/upcoming', sessionController.getUpcomingSessions);

/**
 * @route   POST /api/v1/sessions/book
 * @desc    Full booking - slot select + availability mark + session create
 * @body    mentorId, sessionType, scheduledAt, slotTime, timezone, title, pricing, paymentMethod, availabilityId
 * @access  Private (Mentee)
 */
router.post('/book', validateJoi(sessionValidator.bookSession), sessionController.bookSession);

/**
 * @route   GET /api/v1/sessions/stats
 * @desc    Mentee ka session progress - completed, left, total
 * @access  Private
 */
router.get('/stats', sessionController.getSessionStats);

/**
 * @route   GET /api/v1/sessions/past
 * @desc    Get past/completed sessions
 * @access  Private
 */
router.get('/past', sessionController.getPastSessions);

router.get('/:id/progress', sessionController.getSessionProgress);

/**
 * @route   GET /api/v1/sessions/:id
 * @desc    Get a single session by sessionId - mentor ya mentee dono use karte hain
 *          (Join Session flow ke liye zaroori: room/meeting details yahin se aate hain)
 * @access  Private
 */
router.get('/:id', sessionController.getSessionById);

/**
 * @route   POST /api/v1/sessions/:id/confirm
 * @desc    Confirm session booking (Mentor only)
 * @access  Private (Mentor)
 */
router.post('/:id/confirm', sessionController.confirmSession);

/**
 * @route   POST /api/v1/sessions/:id/start
 * @desc    Start a session (Mentor only)
 * @access  Private (Mentor)
 */
router.post('/:id/start', sessionController.startSession);

/**
 * @route   POST /api/v1/sessions/:id/complete
 * @desc    Complete a session (Mentor only)
 * @access  Private (Mentor)
 */
router.post(
  '/:id/complete',
  validateJoi(sessionValidator.completeSession),
  sessionController.completeSession
);

/**
 * @route   GET /api/v1/sessions/:id/refund-estimate
 * @desc    Get refund estimate before cancellation
 * @access  Private
 */
router.get('/:id/refund-estimate', sessionController.getRefundEstimate);

/**
 * @route   GET /api/v1/sessions/:id/receipt
 * @desc    Get receipt data for a completed booking
 * @query   bookingId (optional - falls back to first completed booking)
 * @access  Private
 */
router.get('/:id/receipt', sessionController.getSessionReceipt);

/**
 * @route   PUT /api/v1/sessions/:id
 * @desc    Update session details
 * @access  Private
 */
router.put(
  '/:id',
  uploadSingle('thumbnailImage', 'image', false),
  parseFormDataFields,
  validateJoi(sessionValidator.updateSession),
  sessionController.updateSession
);

/**
 * @route   DELETE /api/v1/sessions/:id
 * @desc    Hard-delete a session that has no active bookings
 * @access  Private (Mentor)
 */
router.delete('/:id', sessionController.deleteSession);

/**
 * @route   POST /api/v1/sessions/:id/cancel
 * @desc    Cancel a session with refund
 * @access  Private
 */
router.post(
  '/:id/cancel',
  validateJoi(sessionValidator.cancelSession),
  sessionController.cancelSession
);

/**
 * @route   POST /api/v1/sessions/:id/reschedule
 * @desc    Reschedule a session to new date/time
 * @access  Private
 */
router.post(
  '/:id/reschedule',
  validateJoi(sessionValidator.rescheduleSession),
  sessionController.rescheduleSession
);

/**
 * @route   POST /api/v1/sessions/:id/review
 * @desc    Add review for a completed session
 * @access  Private
 */
router.post(
  '/:id/review',
  validateJoi(sessionValidator.addReview),
  sessionController.addReview
);

export default router;