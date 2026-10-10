import express from 'express';
import {
  joinWaitlist,
  getUserPosition,
  getUserWaitlists,
  getMentorWaitlist,
  notifyNextInLine,
  markAsBooked,
  removeFromWaitlist,
  getWaitlistStats,
  offerWaitlistSlot,
  claimWaitlistSlot,
  declineWaitlistSlot,
  updateWaitlistPriority,
  removeWaitlistEntry,
  toggleAutoOffer,
} from '../controllers/waitlist.controller';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import { body, param, query, validationResult } from 'express-validator';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';

const router = express.Router();

/**
 * Validation error handler
 */
const handleValidationErrors = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseHandler.badRequest(res, 'Validation failed', errors.array());
  }
  return next();
};

/**
 * Protected Routes (All require authentication)
 */

// Join waitlist (POST / and POST /join)
const joinValidations = [
  body('mentorId').notEmpty().withMessage('Mentor ID is required').isString(),
  body('sessionType').notEmpty().withMessage('Session type is required').isString(),
  body('timezone').optional().isString(),
  body('notes').optional().isString(),
  body('serviceId').optional().isString(),
  body('serviceTitle').optional().isString(),
  body('preferredDates').optional().isArray(),
  body('preferredTimeSlots').optional().isArray(),
];

router.post('/', AuthMiddleware.authenticate as any, joinValidations, handleValidationErrors, joinWaitlist);
router.post('/join', AuthMiddleware.authenticate as any, joinValidations, handleValidationErrors, joinWaitlist);

// Get user's position in waitlist for a specific mentor
router.get(
  '/position/:mentorId',
  AuthMiddleware.authenticate as any,
  [param('mentorId').notEmpty().isString()],
  handleValidationErrors,
  getUserPosition
);

// Get all waitlist entries for logged-in user (GET /mine and GET /my-waitlists)
router.get('/mine', AuthMiddleware.authenticate as any, getUserWaitlists);
router.get('/my-waitlists', AuthMiddleware.authenticate as any, getUserWaitlists);

// Get waitlist for mentor (GET /mentor and GET /mentor/:mentorId)
router.get('/mentor', AuthMiddleware.authenticate as any, (req, res, next) => {
  (req.params as any).mentorId = req.user?.id || '';
  return getMentorWaitlist(req, res, next);
});

router.get(
  '/mentor/:mentorId',
  AuthMiddleware.authenticate as any,
  [
    param('mentorId').notEmpty().isString(),
    query('status').optional().isString(),
  ],
  handleValidationErrors,
  getMentorWaitlist
);

// Toggle auto-offer setting
router.patch(
  '/settings/auto-offer',
  AuthMiddleware.authenticate as any,
  [body('enabled').isBoolean().withMessage('enabled must be a boolean')],
  handleValidationErrors,
  toggleAutoOffer
);

// Offer slot to waitlist entry (POST /:waitlistId/offer and POST /:waitlistId/approve)
router.post(
  '/:waitlistId/offer',
  AuthMiddleware.authenticate as any,
  [param('waitlistId').notEmpty().isString()],
  handleValidationErrors,
  offerWaitlistSlot
);
router.post(
  '/:waitlistId/approve',
  AuthMiddleware.authenticate as any,
  [param('waitlistId').notEmpty().isString()],
  handleValidationErrors,
  offerWaitlistSlot
);

// Claim offered slot (POST /:waitlistId/claim)
router.post(
  '/:waitlistId/claim',
  AuthMiddleware.authenticate as any,
  [param('waitlistId').notEmpty().isString()],
  handleValidationErrors,
  claimWaitlistSlot
);

// Decline offered slot (POST /:waitlistId/decline)
router.post(
  '/:waitlistId/decline',
  AuthMiddleware.authenticate as any,
  [param('waitlistId').notEmpty().isString()],
  handleValidationErrors,
  declineWaitlistSlot
);

// Update priority (PATCH /:waitlistId/priority)
router.patch(
  '/:waitlistId/priority',
  AuthMiddleware.authenticate as any,
  [
    param('waitlistId').notEmpty().isString(),
    body('delta').optional().isNumeric(),
  ],
  handleValidationErrors,
  updateWaitlistPriority
);

// Remove entry from waitlist (DELETE /:waitlistId/remove)
router.delete(
  '/:waitlistId/remove',
  AuthMiddleware.authenticate as any,
  [param('waitlistId').notEmpty().isString()],
  handleValidationErrors,
  removeWaitlistEntry
);

// Leave/Cancel waitlist entry (DELETE /:waitlistId)
router.delete(
  '/:waitlistId',
  AuthMiddleware.authenticate as any,
  [param('waitlistId').notEmpty().isString()],
  handleValidationErrors,
  removeFromWaitlist
);

// Notify next person in waitlist
router.post(
  '/notify/:mentorId',
  AuthMiddleware.authenticate as any,
  [param('mentorId').notEmpty().isString()],
  handleValidationErrors,
  notifyNextInLine
);

// Mark waitlist entry as booked
router.put(
  '/:waitlistId/book',
  AuthMiddleware.authenticate as any,
  [
    param('waitlistId').notEmpty().isString(),
    body('sessionId').notEmpty().isString(),
  ],
  handleValidationErrors,
  markAsBooked
);

// Get waitlist statistics for mentor
router.get(
  '/stats/:mentorId',
  AuthMiddleware.authenticate as any,
  [param('mentorId').notEmpty().isString()],
  handleValidationErrors,
  getWaitlistStats
);

export default router;