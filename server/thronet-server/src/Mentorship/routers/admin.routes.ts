import { Router } from 'express';
import { adminController } from '../controllers';
import { body, param, query } from 'express-validator';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import { validate } from '@/shared/middlewares/validation.middleware';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import refundAdminController from '../controllers/refundAdmin.controller';

const router = Router();

// routes mein add karo — sabse upar
router.use(AuthMiddleware.authenticate as any);
router.use((req, res, next) => {
  if (req.user?.role !== 'admin') {
    return ResponseHandler.forbidden(res, 'Admin access required');
  }
  next();
});

// Controller se sab isAdmin() checks hata do

/**
 * Admin Validation Rules
 */
const paginationValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
];

const statusUpdateValidation = [
  param('id').notEmpty().withMessage('ID is required'),
  body('status').notEmpty().withMessage('Status is required'),
  body('reason').optional(),
];

/**
 * @route   GET /api/v1/admin/dashboard
 * @desc    Get dashboard statistics
 * @access  Private (Admin)
 */
router.get(
  '/dashboard',
  AuthMiddleware.authenticate as any,
  adminController.getDashboardStats
);

/**
 * @route   GET /api/v1/admin/mentors
 * @desc    Get all mentors with filters
 * @access  Private (Admin)
 */
// / ✅ Replace with
router.get(
  '/mentors',
  AuthMiddleware.authenticate as any,
  validate([
    ...paginationValidation,
    query('status').optional(),
    query('search').optional(),
  ]),
  adminController.getAllMentors
);

/**
 * @route   GET /api/v1/admin/mentors/pending
 * @desc    Get pending mentor approvals
 * @access  Private (Admin)
 */
router.get(
  '/mentors/pending',
  AuthMiddleware.authenticate as any,
  validate(paginationValidation),
  adminController.getPendingMentors
);

/**
 * @route   POST /api/v1/admin/mentors/:id/status
 * @desc    Update mentor status (approve/reject)
 * @access  Private (Admin)
 */
router.post(
  '/mentors/:id/status',
  AuthMiddleware.authenticate as any,
  validate(statusUpdateValidation),
  adminController.updateMentorStatus
);

/**
 * @route   GET /api/v1/admin/sessions
 * @desc    Get all sessions with filters
 * @access  Private (Admin)
 */
router.get(
  '/sessions',
  AuthMiddleware.authenticate as any,
  validate([
    ...paginationValidation,
    query('status').optional(),
    query('sessionType').optional(),
    query('kind')
      .optional()
      .isIn(['booked', 'slots', 'all'])
      .withMessage('kind must be one of: booked, slots, all'),
    query('from')
      .optional()
      .isISO8601()
      .withMessage('from must be a valid ISO 8601 date'),
    query('to')
      .optional()
      .isISO8601()
      .withMessage('to must be a valid ISO 8601 date'),
  ]),
  adminController.getAllSessions
);

/**
 * @route   GET /api/v1/admin/reviews
 * @desc    Get all reviews with filters
 * @access  Private (Admin)
 */
router.get(
  '/reviews',
  AuthMiddleware.authenticate as any,
  validate([
    ...paginationValidation,
    query('reported')
      .optional()
      .isBoolean()
      .withMessage('Reported must be a boolean'),
    query('rating')
      .optional()
      .isInt({ min: 1, max: 5 })
      .withMessage('Rating must be between 1 and 5'),
    query('status')
      .optional()
      .isIn(['all', 'public', 'hidden', 'deleted'])
      .withMessage('Status must be all, public, hidden, or deleted'),
  ]),
  adminController.getAllReviews
);

/**
 * @route   GET /api/v1/admin/reviews/reported
 * @desc    Get reported reviews
 * @access  Private (Admin)
 */
router.get(
  '/reviews/reported',
  AuthMiddleware.authenticate as any,
  validate(paginationValidation),
  adminController.getReportedReviews
);

/**
 * @route   POST /api/v1/admin/reviews/:id/moderate
 * @desc    Moderate a review
 * @access  Private (Admin)
 */
router.post(
  '/reviews/:id/moderate',
  AuthMiddleware.authenticate as any,
  validate([
    param('id').isUUID().withMessage('Invalid ID format'),
    body('action')
      .isIn(['keep', 'delete'])
      .withMessage("Invalid moderation action. Use 'keep' or 'delete'"),
    body('reason').custom((value, { req }) => {
      const action = req.body?.action;
      if (action === 'delete') {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed.length < 5 || trimmed.length > 500) {
          throw new Error('Reason is required (5-500 characters) for delete action');
        }
      }
      return true;
    }),
  ]),
  adminController.moderateReview
);

/**
 * @route   GET /api/v1/admin/payments
 * @desc    Get payment logs/transactions
 * @access  Private (Admin)
 */
router.get(
  '/payments',
  AuthMiddleware.authenticate as any,
  validate([
    ...paginationValidation,
    query('status').optional(),
  ]),
  adminController.getPaymentLogs
);

/**
 * @route   GET /refunds
 * @desc    Missed-session refund requests (pending | refunded)
 * @access  Private (Admin)
 */
router.get(
  '/refunds',
  AuthMiddleware.authenticate as any,
  validate([...paginationValidation, query('status').optional().isIn(['pending', 'refunded'])]),
  refundAdminController.list
);

/**
 * @route   POST /refunds/:bookingId/mark-refunded
 * @access  Private (Admin)
 */
router.post(
  '/refunds/:bookingId/mark-refunded',
  AuthMiddleware.authenticate as any,
  validate([
    param('bookingId').isMongoId().withMessage('Invalid booking ID'),
    body('reference').trim().isLength({ min: 3, max: 100 }).withMessage('Reference must be 3-100 characters'),
  ]),
  refundAdminController.markRefunded
);

/**
 * @route   POST /refunds/:bookingId/pay
 * @desc    Send missed-session refund to student's UPI via RazorpayX payout
 * @access  Private (Admin)
 */
router.post(
  '/refunds/:bookingId/pay',
  AuthMiddleware.authenticate as any,
  validate([param('bookingId').isMongoId().withMessage('Invalid booking ID')]),
  adminController.payRefund.bind(adminController)
);

export default router;