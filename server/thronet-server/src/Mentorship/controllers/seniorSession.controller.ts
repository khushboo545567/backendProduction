import { Response } from 'express';
import { AuthRequest } from '../middlewares/auth.middleware';
import SeniorSessionService from '../services/seniorSession.service';
import { ResponseHandler } from '../../utils/responseHandler';

class SeniorSessionController {
  /**
   * Create a new Senior Session
   * POST /senior-sessions
   */
  async createSession(req: AuthRequest, res: Response) {
    try {
      const userId = req.user.id;

      const session = await SeniorSessionService.createSession(
        userId,
        req.body
      );

      return ResponseHandler.success(
        res,
        session,
        'Senior session created successfully'
      );
    } catch (error) {
      return ResponseHandler.error(res, error);
    }
  }

  /**
   * Get all sessions belonging to the authenticated Senior Mentor
   * GET /senior-sessions/my
   */
  async getMySessions(req: AuthRequest, res: Response) {
    try {
      const userId = req.user.id;

      const sessions = await SeniorSessionService.getMySessions(userId);

      return ResponseHandler.success(
        res,
        sessions,
        'Senior sessions retrieved successfully'
      );
    } catch (error) {
      return ResponseHandler.error(res, error);
    }
  }

  /**
   * Get a single Senior Session
   * GET /senior-sessions/:sessionId
   */
  async getSessionById(req: AuthRequest, res: Response) {
    try {
      const userId = req.user.id;
      const { sessionId } = req.params;

      const session = await SeniorSessionService.getSessionById(
        sessionId,
        userId
      );

      return ResponseHandler.success(
        res,
        session,
        'Senior session retrieved successfully'
      );
    } catch (error) {
      return ResponseHandler.error(res, error);
    }
  }

  /**
   * Update a Senior Session
   * PUT /senior-sessions/:sessionId
   */
  async updateSession(req: AuthRequest, res: Response) {
    try {
      const userId = req.user.id;
      const { sessionId } = req.params;

      const session = await SeniorSessionService.updateSession(
        sessionId,
        userId,
        req.body
      );

      return ResponseHandler.success(
        res,
        session,
        'Senior session updated successfully'
      );
    } catch (error) {
      return ResponseHandler.error(res, error);
    }
  }

  /**
   * Cancel/Delete a Senior Session
   * DELETE /senior-sessions/:sessionId
   */
  async cancelSession(req: AuthRequest, res: Response) {
    try {
      const userId = req.user.id;
      const { sessionId } = req.params;

      const session = await SeniorSessionService.cancelSession(
        sessionId,
        userId
      );

      return ResponseHandler.success(
        res,
        session,
        'Senior session cancelled successfully'
      );
    } catch (error) {
      return ResponseHandler.error(res, error);
    }
  }
}

export default new SeniorSessionController();