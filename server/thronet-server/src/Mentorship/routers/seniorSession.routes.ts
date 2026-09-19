import { Router } from 'express';

import SeniorSessionController from '../controllers/seniorSession.controller';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';

import {
  createSeniorSessionValidator,
  updateSeniorSessionValidator,
  seniorSessionIdValidator,
} from '../validations/seniorSession.validator';

const router = Router();

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
 * Get a single Senior Session
 * GET /senior-sessions/:sessionId
 */
router.get(
  '/:sessionId',
  seniorSessionIdValidator,
  SeniorSessionController.getSessionById
);

/**
 * Update a Senior Session
 * PUT /senior-sessions/:sessionId
 */
router.put(
  '/:sessionId',
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

export default router;