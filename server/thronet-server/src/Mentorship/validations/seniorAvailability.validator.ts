import { body, param, query } from 'express-validator';
import { validate } from '../../shared/middlewares/validation.middleware';

export const updateAvailabilityValidator = validate([
  body('timezone')
    .optional()
    .isString()
    .withMessage('Timezone must be a string'),

  body('slotInterval')
    .optional()
    .isInt({ min: 15, max: 120 })
    .withMessage('Slot interval must be between 15 and 120 minutes'),

  body('breakDuration')
    .optional()
    .isInt({ min: 0, max: 60 })
    .withMessage('Break duration must be between 0 and 60 minutes'),

  body('weeklySchedule')
    .optional()
    .isArray()
    .withMessage('Weekly schedule must be an array'),

  body('weeklySchedule.*.day')
    .optional()
    .isIn(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    .withMessage('Invalid day of week'),

  body('weeklySchedule.*.enabled')
    .optional()
    .isBoolean()
    .withMessage('Enabled must be a boolean'),

  body('weeklySchedule.*.timeRanges')
    .optional()
    .isArray()
    .withMessage('Time ranges must be an array'),

  body('weeklySchedule.*.timeRanges.*.startTime')
    .optional()
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('Start time must be in HH:mm format'),

  body('weeklySchedule.*.timeRanges.*.endTime')
    .optional()
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('End time must be in HH:mm format'),
]);

export const getSlotsValidator = validate([
  query('date')
    .notEmpty()
    .withMessage('Date is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Date must be in YYYY-MM-DD format'),
    
  query('duration')
    .notEmpty()
    .withMessage('Duration is required')
    .isInt({ min: 15, max: 240 })
    .withMessage('Duration must be between 15 and 240 minutes')
    .toInt(),
]);

export const getMonthlySlotsValidator = validate([
  query('startDate')
    .notEmpty()
    .withMessage('Start date is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Start date must be in YYYY-MM-DD format'),
    
  query('endDate')
    .notEmpty()
    .withMessage('End date is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('End date must be in YYYY-MM-DD format'),

  query('duration')
    .optional()
    .isInt({ min: 15, max: 240 })
    .withMessage('Duration must be between 15 and 240 minutes')
    .toInt(),

  query('mentorId')
    .optional()
    .isUUID()
    .withMessage('Mentor ID must be a valid UUID'),
]);

export const addBlockedTimeValidator = validate([
  body('date')
    .notEmpty()
    .withMessage('Date is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Date must be in YYYY-MM-DD format'),
    
  body('startTime')
    .notEmpty()
    .withMessage('Start time is required')
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('Start time must be in HH:mm format'),

  body('endTime')
    .notEmpty()
    .withMessage('End time is required')
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('End time must be in HH:mm format'),

  body('reason')
    .optional()
    .isString()
    .isLength({ max: 200 })
    .withMessage('Reason cannot exceed 200 characters'),
]);

export const removeBlockedTimeValidator = validate([
  param('id')
    .notEmpty()
    .withMessage('Blocked time ID is required')
    .isMongoId()
    .withMessage('Invalid ID format'),
]);
