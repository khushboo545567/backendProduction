import { Request, Response, NextFunction } from 'express';
import { getAuthToken } from '@/shared/middlewares/auth.middleware';
import { groupService } from '../services';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import { User } from '@/shared/models/index.models';

class GroupController {
  /**
   * @route   POST /api/v1/mentorship/group-sessions
   * @access  Private (Mentor)
   */
  async createGroupSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const file = req.file as Express.Multer.File | undefined;
      const session = await groupService.createGroupSession(
        { ...req.body, mentorId: userId },
        file,
        authToken
      );

      ResponseHandler.created(res, 'Group session created successfully', session);
    } catch (error: any) {
      logger.error('Failed to create group session:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/group-sessions/:id
   * @access  Public
   */
  async getGroupSessionById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const authToken = getAuthToken(req) || undefined;
      let userId = req.user?.id ?? req.user?.userId;
      if (!userId && authToken) {
        try {
          const decoded: any = User.verifyToken(authToken, 'access');
          userId = decoded?.userId;
        } catch {
          // ignore
        }
      }

      const session = await groupService.getGroupSessionById(id, authToken);
      const sanitized = await groupService.sanitizeGroupSession(session, userId);

      ResponseHandler.success(res, 'Group session retrieved successfully', sanitized);
    } catch (error: any) {
      logger.error('Failed to fetch group session:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/group-sessions
   * @access  Public
   */
  async getAllGroupSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { page = 1, limit = 10, status, topic, mentorId } = req.query;
      const authToken = getAuthToken(req) || undefined;

      const result = await groupService.getAllGroupSessions(
        Number(page),
        Number(limit),
        {
          status: status as string | undefined,
          topic: topic as string | undefined,
          mentorId: mentorId as string | undefined,
        },
        authToken
      );

      const sanitizedSessions = await Promise.all(
        result.sessions.map((s: any) => groupService.sanitizeGroupSession(s, req.user?.id))
      );

      ResponseHandler.paginated(
        res,
        'Group sessions retrieved successfully',
        sanitizedSessions,
        result.page,
        result.limit,
        result.total
      );
    } catch (error: any) {
      logger.error('Failed to fetch group sessions:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/group-sessions/upcoming
   * @access  Public
   */
  async getUpcomingGroupSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { mentorId, limit = 10 } = req.query;
      const authToken = getAuthToken(req) || undefined;

      const sessions = await groupService.getUpcomingGroupSessions(
        mentorId as string | undefined,
        Number(limit),
        authToken
      );

      const sanitizedSessions = await Promise.all(
        sessions.map((s: any) => groupService.sanitizeGroupSession(s, req.user?.id))
      );

      ResponseHandler.success(res, 'Upcoming group sessions retrieved successfully', sanitizedSessions);
    } catch (error: any) {
      logger.error('Failed to fetch upcoming group sessions:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/group-sessions/:id/join
   * @route   POST /api/v1/mentorship/group-sessions/:id/request   (alias — mentee UI calls this one)
   * @desc    Mentee sends a request to join a group session. Creates a
   *          PENDING request — does NOT register the mentee directly.
   *          Both routes point here so existing callers of "/join" keep
   *          working while the new mentee UI (which calls "/request") also
   *          works without any backend duplication.
   * @access  Private (Mentee)
   */
  async joinGroupSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const { transactionId } = req.body;

      const session = await groupService.joinGroupSession(id, userId, transactionId, authToken);
      ResponseHandler.success(res, 'Join request sent successfully', session);
    } catch (error: any) {
      logger.error('Failed to join group session:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/group-sessions/:id/request
   * @desc    Get the logged-in mentee's own join-request status for a
   *          session — powers the Join Group / Request Pending / Joined
   *          button state on the mentor-card page.
   * @access  Private (Mentee)
   */
  async getMyJoinRequestStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const result = await groupService.getMyJoinRequestStatus(id, userId, authToken);

      if (!result) {
        ResponseHandler.notFound(res, 'No join request found for this session');
        return;
      }

      ResponseHandler.success(res, 'Join request status retrieved successfully', result);
    } catch (error: any) {
      logger.error('Failed to fetch join request status:', error);
      next(error);
    }
  }

  /**
   * @route   PATCH /api/v1/mentorship/group-sessions/:id/requests/:menteeId/accept
   * @desc    Mentor accepts a mentee's pending join request. This is the
   *          only place a mentee actually becomes a confirmed participant.
   * @access  Private (Mentor)
   */
  async acceptJoinRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id, menteeId } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.acceptJoinRequest(id, userId, menteeId, authToken);
      ResponseHandler.success(res, 'Join request accepted successfully', session);
    } catch (error: any) {
      logger.error('Failed to accept join request:', error);
      next(error);
    }
  }

  /**
   * @route   PATCH /api/v1/mentorship/group-sessions/:id/requests/:menteeId/reject
   * @desc    Mentor rejects a mentee's pending join request.
   * @access  Private (Mentor)
   */
  async rejectJoinRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id, menteeId } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.rejectJoinRequest(id, userId, menteeId, authToken);
      ResponseHandler.success(res, 'Join request rejected successfully', session);
    } catch (error: any) {
      logger.error('Failed to reject join request:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/group-sessions/mentor/join-requests
   * @desc    All PENDING join requests across the mentor's group sessions —
   *          powers the "Join Requests" panel in the mentor dashboard.
   *          This is the piece that was missing: notifications were firing
   *          but there was nowhere for the mentor to actually act on them.
   * @access  Private (Mentor)
   */
  async getMentorJoinRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const rows = await groupService.getPendingJoinRequestsForMentor(userId);
      ResponseHandler.success(res, 'Pending join requests retrieved successfully', rows);
    } catch (error: any) {
      logger.error('Failed to fetch mentor join requests:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/group-sessions/:id/leave
   * @access  Private
   */
  async leaveGroupSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.leaveGroupSession(id, userId, authToken);
      ResponseHandler.success(res, 'Successfully left group session', session);
    } catch (error: any) {
      logger.error('Failed to leave group session:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/group-sessions/:id/start
   * @access  Private (Mentor)
   */
  async startGroupSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.startGroupSession(id, userId, authToken);
      const sanitized = await groupService.sanitizeGroupSession(session, userId);
      ResponseHandler.success(res, 'Group session started successfully', sanitized);
    } catch (error: any) {
      logger.error('Failed to start group session:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/group-sessions/:id/complete
   * @access  Private (Mentor)
   */
  async completeGroupSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const { actualDuration, attendees } = req.body;
      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.completeGroupSession(
        id,
        userId,
        actualDuration,
        attendees,
        authToken
      );
      ResponseHandler.success(res, 'Group session completed successfully', session);
    } catch (error: any) {
      logger.error('Failed to complete group session:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/group-sessions/:id/cancel
   * @access  Private (Mentor)
   */
  async cancelGroupSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const { reason } = req.body;
      if (!reason) {
        ResponseHandler.badRequest(res, 'Cancellation reason is required');
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.cancelGroupSession(id, userId, reason, authToken);
      ResponseHandler.success(res, 'Group session cancelled successfully', session);
    } catch (error: any) {
      logger.error('Failed to cancel group session:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/group-sessions/:id/feedback
   * @access  Private
   */
  async addFeedback(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const { rating, comment } = req.body;
      if (!rating) {
        ResponseHandler.badRequest(res, 'Rating is required');
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.addFeedback(id, userId, rating, comment, authToken);
      ResponseHandler.success(res, 'Feedback submitted successfully', session);
    } catch (error: any) {
      logger.error('Failed to add feedback:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/group-sessions/my-sessions
   * @access  Private
   */
  async getMyGroupSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id ?? req.user?.userId;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const { role = 'mentee' } = req.query;
      const authToken = getAuthToken(req) || undefined;

      const sessions = await groupService.getMyGroupSessions(
        userId,
        role as 'mentor' | 'mentee',
        authToken
      );
      ResponseHandler.success(res, 'My group sessions retrieved successfully', sessions);
    } catch (error: any) {
      logger.error('Failed to fetch my group sessions:', error);
      next(error);
    }
  }

  /**
   * @route   PUT /api/v1/mentorship/group-sessions/:id
   * @access  Private (Mentor)
   */
  async updateGroupSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const file = req.file as Express.Multer.File | undefined;
      const session = await groupService.updateGroupSession(
        id,
        userId,
        req.body,
        file,
        authToken
      );

      ResponseHandler.success(res, 'Group session updated successfully', session);
    } catch (error: any) {
      logger.error('Failed to update group session:', error);
      next(error);
    }
  }

  /**
   * @route   DELETE /api/v1/mentorship/group-sessions/:id
   * @access  Private (Mentor)
   */
  async deleteGroupSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      await groupService.deleteGroupSession(id, userId, authToken);
      ResponseHandler.success(res, 'Group session deleted successfully', null);
    } catch (error: any) {
      logger.error('Failed to delete group session:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/group-sessions/mentor/participants
   * @desc    All group-session participants across the mentor's sessions,
   *          shaped like 1:1 booking rows — powers the Booking dashboard.
   * @access  Private (Mentor)
   */
  async getMentorGroupParticipants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const rows = await groupService.getGroupSessionParticipantsForMentor(userId);
      ResponseHandler.success(res, 'Group session participants retrieved successfully', rows);
    } catch (error: any) {
      logger.error('Failed to fetch mentor group session participants:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/group-sessions/:id/template-slots?date=YYYY-MM-DD
   * @desc    Bookable slots for a group-session template on a given date,
   *          derived from the mentor's Availability — powers the
   *          "Select Date & Time" calendar for template-based group sessions.
   * @access  Public
   */
  async getTemplateAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const { date } = req.query;

      if (!date) {
        ResponseHandler.badRequest(res, 'Query param "date" (YYYY-MM-DD) is required');
        return;
      }

      const slots = await groupService.getTemplateAvailability(id, date as string);
      ResponseHandler.success(res, 'Template availability retrieved successfully', slots);
    } catch (error: any) {
      logger.error('Failed to fetch template availability:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/group-sessions/:id/join-by-slot
   * @desc    Mentee picks a specific date+time slot for a template group
   *          session and sends a join request. If an open instance already
   *          exists for that slot, joins it; otherwise creates a new
   *          instance and books that slot from the mentor's Availability.
   * @access  Private (Mentee)
   */
  async joinBySlot(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const { scheduledAt, transactionId } = req.body;
      if (!scheduledAt) {
        ResponseHandler.badRequest(res, '"scheduledAt" is required to pick a slot');
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.joinBySlot(
        id,
        userId,
        scheduledAt,
        transactionId,
        authToken
      );

      ResponseHandler.success(res, 'Join request sent successfully', session);
    } catch (error: any) {
      logger.error('Failed to join group session by slot:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/group-sessions/:id/attend
   * @desc    Mentee clicks Join Meet to mark attendance
   * @access  Private (Mentee)
   */
  async markAttendance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user?.id ?? req.user?.userId;
      if (!userId) {
        ResponseHandler.unauthorized(res);
        return;
      }

      const authToken = getAuthToken(req) || undefined;
      const session = await groupService.markMenteeAttendance(id, userId, authToken);
      ResponseHandler.success(res, 'Attendance marked successfully', session);
    } catch (error: any) {
      logger.error('Failed to mark attendance:', error);
      next(error);
    }
  }
}

export default new GroupController();