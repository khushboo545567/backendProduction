// src/validators/review.validator.ts

import { body, param, query } from 'express-validator';

export const createReviewValidation = [
  body('sessionId')
    .notEmpty()
    .withMessage('Session ID is required')
    .isMongoId()
    .withMessage('Invalid session ID'),

  body('rating')
    .notEmpty()
    .withMessage('Rating is required')
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),

  body('comment')
    .optional()
    .isString()
    .withMessage('Comment must be a string')
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Comment cannot exceed 1000 characters'),

  body('categories')
    .optional()
    .isObject()
    .withMessage('Categories must be an object'),

  body('categories.communication')
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage('Communication rating must be between 1 and 5'),

  body('categories.knowledge')
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage('Knowledge rating must be between 1 and 5'),

  body('categories.helpfulness')
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage('Helpfulness rating must be between 1 and 5'),

  body('categories.professionalism')
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage('Professionalism rating must be between 1 and 5'),

  body('isAnonymous')
    .optional()
    .isBoolean()
    .withMessage('isAnonymous must be a boolean'),
];

export const updateReviewValidation = [
  param('id')
    .notEmpty()
    .withMessage('Review ID is required')
    .isMongoId()
    .withMessage('Invalid review ID'),

  body('rating')
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),

  body('comment')
    .optional()
    .isString()
    .withMessage('Comment must be a string')
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Comment cannot exceed 1000 characters'),

  body('categories')
    .optional()
    .isObject()
    .withMessage('Categories must be an object'),
];

export const respondToReviewValidation = [
  param('id')
    .notEmpty()
    .withMessage('Review ID is required')
    .isMongoId()
    .withMessage('Invalid review ID'),

  body('response')
    .notEmpty()
    .withMessage('Response is required')
    .isString()
    .withMessage('Response must be a string')
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage('Response must be between 10 and 500 characters'),
];

export const getReviewsValidation = [
  query('mentorId')
    .optional()
    .isMongoId()
    .withMessage('Invalid mentor ID'),

  query('sessionId')
    .optional()
    .isMongoId()
    .withMessage('Invalid session ID'),

  query('rating')
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),

  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),

  query('sortBy')
    .optional()
    .isIn(['createdAt', 'rating', 'helpfulness'])
    .withMessage('Invalid sort field'),

  query('order')
    .optional()
    .isIn(['asc', 'desc'])
    .withMessage('Order must be asc or desc'),
];

export const deleteReviewValidation = [
  param('id')
    .notEmpty()
    .withMessage('Review ID is required')
    .isMongoId()
    .withMessage('Invalid review ID'),
];

export const reportReviewValidation = [
  param('id').notEmpty().withMessage('Review ID is required'),
  body('reason')
    .notEmpty()
    .withMessage('Report reason is required')
    .isIn(['spam', 'inappropriate', 'fake', 'harassment', 'other'])
    .withMessage('Reason must be one of: spam, inappropriate, fake, harassment, other'),
  body('note')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 300 })
    .withMessage('Note cannot exceed 300 characters'),
];