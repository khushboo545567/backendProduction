import { body, param } from 'express-validator';

export const createSeniorSessionValidator = [
  body('title')
    .trim()
    .notEmpty()
    .withMessage('Title is required')
    .isLength({ min: 3, max: 200 })
    .withMessage('Title must be between 3 and 200 characters'),

  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description cannot exceed 1000 characters'),

  body('sessionType')
    .notEmpty()
    .withMessage('Session type is required')
    .isIn(['one_to_one', 'group'])
    .withMessage('Invalid session type'),

  body('scheduledAt')
    .if((value, { req }) => req.body.sessionType === 'group' || (value !== undefined && value !== null && value !== ''))
    .notEmpty()
    .withMessage('Scheduled time is required for group sessions')
    .isISO8601()
    .withMessage('Scheduled time must be a valid date'),

  body('duration')
    .notEmpty()
    .withMessage('Duration is required')
    .isInt({ min: 15, max: 240 })
    .withMessage('Duration must be between 15 and 240 minutes'),

  body('timezone')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Invalid timezone'),

  body('category')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Category must be between 2 and 100 characters'),

  body('price')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Price cannot be negative'),

  body('thumbnailImage')
    .optional()
    .isURL()
    .withMessage('Thumbnail image must be a valid URL'),

  body('attachments')
    .optional()
    .isArray()
    .withMessage('Attachments must be an array'),

  body('attachments.*')
    .optional()
    .isURL()
    .withMessage('Each attachment must be a valid URL'),
];


export const updateSeniorSessionValidator = [
  param('sessionId')
    .notEmpty()
    .withMessage('Session ID is required')
    .isUUID()
    .withMessage('Invalid session ID'),

  body('title')
    .optional()
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage('Title must be between 3 and 200 characters'),

  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description cannot exceed 1000 characters'),

  body('sessionType')
    .optional()
    .isIn(['one_to_one', 'group'])
    .withMessage('Invalid session type'),

  body('scheduledAt')
    .optional()
    .isISO8601()
    .withMessage('Scheduled time must be a valid date'),

  body('duration')
    .optional()
    .isInt({ min: 15, max: 240 })
    .withMessage('Duration must be between 15 and 240 minutes'),

  body('timezone')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Invalid timezone'),

  body('category')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Category must be between 2 and 100 characters'),

  body('price')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Price cannot be negative'),

  body('thumbnailImage')
    .optional()
    .isURL()
    .withMessage('Thumbnail image must be a valid URL'),

  body('attachments')
    .optional()
    .isArray()
    .withMessage('Attachments must be an array'),

  body('attachments.*')
    .optional()
    .isURL()
    .withMessage('Each attachment must be a valid URL'),
];


export const seniorSessionIdValidator = [
  param('sessionId')
    .notEmpty()
    .withMessage('Session ID is required')
    .isUUID()
    .withMessage('Invalid session ID'),
];

export const seniorBookingIdValidator = [
  param('sessionId')
    .notEmpty()
    .withMessage('Session ID is required')
    .isUUID()
    .withMessage('Invalid session ID'),
  param('bookingId')
    .notEmpty()
    .withMessage('Booking ID is required'),
];