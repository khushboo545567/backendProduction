import { Router } from 'express';
console.log('✅ [BOOT] seniorAvailability.routes.ts parsed!');

import SeniorAvailabilityController from '../controllers/seniorAvailability.controller';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';

import {
  updateAvailabilityValidator,
  getSlotsValidator,
  getMonthlySlotsValidator,
  addBlockedTimeValidator,
  removeBlockedTimeValidator
} from '../validations/seniorAvailability.validator';

const router = Router();

/**
 * Get monthly available slots for a date range (dynamic generation)
 * Publicly queryable for booking calendar with optional auth
 * GET /senior-availability/monthly-slots?mentorId=...&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&duration=60
 */
router.get(
  '/monthly-slots',
  AuthMiddleware.authenticateOptional,
  getMonthlySlotsValidator,
  SeniorAvailabilityController.getMonthlySlots
);

/**
 * Get available slots for a specific date (dynamic generation)
 * Publicly queryable with optional auth
 * GET /senior-availability/slots?mentorId=...&date=YYYY-MM-DD&duration=60
 */
router.get(
  '/slots',
  AuthMiddleware.authenticateOptional,
  getSlotsValidator,
  SeniorAvailabilityController.getAvailableSlots
);

/**
 * Get mentor's availability configuration
 * Accessible with optional auth if mentorId query is provided, or authenticated user
 * GET /senior-availability/config
 */
router.get(
  '/config',
  AuthMiddleware.authenticateOptional,
  SeniorAvailabilityController.getAvailabilityConfig
);

/**
 * Create or update mentor's availability configuration
 * PUT /senior-availability/config (Strict Auth Required)
 */
router.put(
  '/config',
  AuthMiddleware.authenticate,
  updateAvailabilityValidator,
  SeniorAvailabilityController.updateAvailabilityConfig
);

/**
 * Block a specific time frame
 * POST /senior-availability/blocked (Strict Auth Required)
 */
router.post(
  '/blocked',
  AuthMiddleware.authenticate,
  addBlockedTimeValidator,
  SeniorAvailabilityController.addBlockedTime
);

/**
 * Unblock a specific time frame
 * DELETE /senior-availability/blocked/:id (Strict Auth Required)
 */
router.delete(
  '/blocked/:id',
  AuthMiddleware.authenticate,
  removeBlockedTimeValidator,
  SeniorAvailabilityController.removeBlockedTime
);

export default router;
