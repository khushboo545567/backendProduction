import mentorService from './mentor.service';
import { logger } from '@/shared/logger.util';
import { NotFoundError } from '@/shared/errors/app.error';
import { User } from '@/auth/models';
import { Query } from '../models';
import { BadRequestError, ForbiddenError } from '@/shared/errors/app.error';
import { generateSecureId } from '@/shared/security';
import queryRepository from '../repositories/query.repository';
import queryValidator from '../validations/query.validator';
import mentorRepository from '../repositories/mentor.repository';
import notificationService, { NotificationType, NotificationChannel } from './notification.service';

interface SubmitQueryInput {
  mentorId: string;
  menteeId: string;
  question: string;
  context?: string;
  attachments?: string[];
  category?: string;
  priority?: 'normal' | 'high';
  transactionId?: string;
}

class QueryService {
  /**
   * Submit a new query
   */
  async submitQuery(input: SubmitQueryInput, authToken?: string): Promise<any> {
    try {
      logger.info(`Submitting query to mentor ${input.mentorId}`);

      // Validate mentor exists
      const mentor = await mentorService.getMentorById(input.mentorId, authToken);
      if (!mentor) {
        throw new NotFoundError('MENTOR_NOT_FOUND');
      }

      // ✅ FIX: the mentee lookup result was never captured or checked —
      // `await User.findByUserId(input.menteeId)` ran but its return value
      // was discarded, so a bad/nonexistent menteeId silently passed through
      // instead of throwing NOT_FOUND. Now it's actually validated, and we
      // keep the record to use the mentee's name in the mentor's notification.
      const mentee = await User.findByUserId(input.menteeId);
      if (!mentee) {
        throw new NotFoundError('MENTEE_NOT_FOUND');
      }

      // Get pricing
      const amount = mentor.pricing?.askQuery || 199;

      // Create query
      const query = new Query({
        queryId: generateSecureId(), // Generate unique queryId UUID
        mentorId: input.mentorId,
        menteeId: input.menteeId,
        question: input.question,
        context: input.context,
        attachments: input.attachments,
        category: input.category,
        priority: input.priority || 'normal',
        status: 'pending',
        pricing: {
          amount,
          currency: 'INR',
          transactionId: input.transactionId,
          paidAt: input.transactionId ? new Date() : undefined,
        },
      });

      await query.save();

      logger.info(`Query submitted successfully: ${query._id}`);

      // ✅ Notify the mentor — this was a TODO before, mentor dashboard's
      // Notifications page stayed empty because nothing ever created a
      // notification row. Non-blocking: a notification failure shouldn't
      // fail the query submission itself.
      const menteeName = `${(mentee as any).firstName ?? ''} ${(mentee as any).lastName ?? ''}`.trim() || 'A mentee';
      try {
        await notificationService.sendNotification({
          userId: mentor.userId,
          type: NotificationType.QUERY_RECEIVED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'New Query',
            message: `${menteeName} asked you a query`,
            menteeName,
            question: input.question,
            queryId: query.queryId,
            mentorId: input.mentorId,
          },
          priority: 'normal',
        });
      } catch (notifyErr: any) {
        logger.error('Failed to notify mentor of new query:', notifyErr);
      }

      return query.toObject();
    } catch (error: any) {
      logger.error('Failed to submit query:', error);
      throw error;
    }
  }

  /**
   * Get query by ID
   */
  async getQueryById(queryId: string, userId?: string, _authToken?: string): Promise<any> {
    try {
      const query = await queryRepository.findByQueryId(queryId);
      if (!query) {
        throw new NotFoundError('QUERY_NOT_FOUND');
      }

      // Check access permission
      if (userId && query.mentorId !== userId && query.menteeId !== userId) {
        throw new ForbiddenError(
          'UNAUTHORIZED_ACCESS'
        );
      }

      return query;
    } catch (error: any) {
      logger.error('Failed to fetch query:', error);
      throw error;
    }
  }

  /**
   * Get all queries for a user
   */
  async getAllQueries(
    userId: string,
    role: 'mentor' | 'mentee',
    page: number = 1,
    limit: number = 10,
    status?: string,
    _authToken?: string
  ): Promise<{
    queries: any[];
    total: number;
    page: number;
    limit: number;
  }> {
    try {
      const query: any = {};

      // Role-based filter
      if (role === 'mentor') {
        query.mentorId = userId;
      } else {
        query.menteeId = userId;
      }

      // Status filter
      if (status) {
        query.status = status;
      }

      const skip = (page - 1) * limit;

      const [queries, total] = await Promise.all([
        queryRepository.findAll(query, skip, limit),
        queryRepository.count(query),
      ]);

      return {
        queries,
        total,
        page,
        limit,
      };
    } catch (error: any) {
      logger.error('Failed to fetch queries:', error);
      throw error;
    }
  }

  /**
   * Get pending queries for mentor
   */
  async getPendingQueries(mentorId: string, _authToken?: string): Promise<any[]> {
    try {
      const queries = await queryRepository.findPendingByMentorId(mentorId);
      return queries;
    } catch (error: any) {
      logger.error('Failed to fetch pending queries:', error);
      throw error;
    }
  }

  /**
   * Answer a query (mentor only)
   */
  async answerQuery(
    queryId: string,
    userId: string,      // ye User ka userId hai (auth se aata hai)
    answer: string,
    authToken?: string
  ): Promise<any> {
    try {
      // ✅ Pehle userId se mentor dhundo
      const mentor = await mentorRepository.findByUserId(userId);

      if (!mentor) {
        throw new ForbiddenError('Only mentors can answer queries');
      }

      const mentorId = mentor.mentorId;

      // ✅ Ab getQueryById ko mentorId se call karo, userId se nahi
      const query = await this.getQueryById(queryId, mentorId, authToken);

      if (query.mentorId !== mentorId) {
        throw new ForbiddenError('Only the mentor can answer this query');
      }

      if (query.status !== 'pending') {
        throw new BadRequestError('Query has already been answered or expired');
      }

      await query.answerQuery(answer);

      logger.info(`Query answered: ${queryId}`);

      // ✅ Notify the mentee that their query was answered
      try {
        const mentorUser = await User.findByUserId(userId);
        const mentorName = `${(mentorUser as any)?.firstName ?? ''} ${(mentorUser as any)?.lastName ?? ''}`.trim() || 'Your mentor';

        await notificationService.sendNotification({
          userId: query.menteeId,
          type: NotificationType.QUERY_ANSWERED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'Query Answered',
            message: `${mentorName} answered your query`,
            mentorName,
            queryId: query.queryId,
          },
          priority: 'normal',
        });
      } catch (notifyErr: any) {
        logger.error('Failed to notify mentee of answered query:', notifyErr);
      }

      return query;

    } catch (error: any) {
      logger.error('Failed to answer query:', error);
      throw error;
    }
  }

  /**
   * Submit follow-up question (mentee only)
   */
  async submitFollowUp(
    queryId: string,
    menteeId: string,
    question: string,
    authToken?: string
  ): Promise<any> {
    try {
      const query = await this.getQueryById(queryId, menteeId, authToken);

      if (query.menteeId !== menteeId) {
        throw new ForbiddenError(
          'Only the mentee can submit a follow-up'
        );
      }

      if (query.status !== 'answered') {
        throw new BadRequestError(
          'Can only submit follow-up for answered queries'
        );
      }

      if (query.followUp?.askedAt) {
        throw new BadRequestError(
          'Follow-up already submitted'
        );
      }

      await query.addFollowUp(question);

      logger.info(`Follow-up submitted for query: ${queryId}`);

      // ✅ Notify the mentor of the follow-up, same pattern as new queries
      try {
        const mentee = await User.findByUserId(menteeId);
        const menteeName = `${(mentee as any)?.firstName ?? ''} ${(mentee as any)?.lastName ?? ''}`.trim() || 'A mentee';

        await notificationService.sendNotification({
          userId: query.mentorId,
          type: NotificationType.QUERY_RECEIVED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'Follow-up Question',
            message: `${menteeName} sent a follow-up question`,
            menteeName,
            question,
            queryId: query.queryId,
          },
          priority: 'normal',
        });
      } catch (notifyErr: any) {
        logger.error('Failed to notify mentor of follow-up:', notifyErr);
      }

      return query;
    } catch (error: any) {
      logger.error('Failed to submit follow-up:', error);
      throw error;
    }
  }

  /**
   * Answer follow-up question (mentor only)
   */
  async answerFollowUp(queryId: string, userId: string, answer: string, authToken?: string) {
    try {
      const mentor = await mentorRepository.findByUserId(userId);
      if (!mentor) throw new ForbiddenError('Only mentors can answer queries');

      const mentorId = mentor.mentorId;
      const query = await this.getQueryById(queryId, mentorId, authToken);

      if (query.mentorId !== mentorId) {
        throw new ForbiddenError(
          'Only the mentor can answer the follow-up'
        );
      }

      if (!query.followUp?.question) {
        throw new BadRequestError(
          'No follow-up question found'
        );
      }

      if (query.followUp.answeredAt) {
        throw new BadRequestError(
          'Follow-up already answered'
        );
      }

      await query.answerFollowUp(answer);

      logger.info(`Follow-up answered for query: ${queryId}`);

      // ✅ Notify the mentee, same pattern as answerQuery
      try {
        const mentorUser = await User.findByUserId(userId);
        const mentorName = `${(mentorUser as any)?.firstName ?? ''} ${(mentorUser as any)?.lastName ?? ''}`.trim() || 'Your mentor';

        await notificationService.sendNotification({
          userId: query.menteeId,
          type: NotificationType.QUERY_ANSWERED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'Follow-up Answered',
            message: `${mentorName} answered your follow-up`,
            mentorName,
            queryId: query.queryId,
          },
          priority: 'normal',
        });
      } catch (notifyErr: any) {
        logger.error('Failed to notify mentee of answered follow-up:', notifyErr);
      }

      return query;
    } catch (error: any) {
      logger.error('Failed to answer follow-up:', error);
      throw error;
    }
  }

  /**
   * Add feedback to query
   */
  async addFeedback(
    queryId: string,
    menteeId: string,
    rating: number,
    comment?: string,
    authToken?: string
  ): Promise<any> {
    try {
      const query = await this.getQueryById(queryId, menteeId, authToken);

      if (query.menteeId !== menteeId) {
        throw new ForbiddenError(
          'Only the mentee can provide feedback'
        );
      }

      if (query.status !== 'answered') {
        throw new BadRequestError(
          'Can only provide feedback for answered queries'
        );
      }

      if (query.feedback) {
        throw new BadRequestError(
          'Feedback already submitted'
        );
      }

      await query.addFeedback(rating, comment);

      logger.info(`Feedback added for query: ${queryId}`);

      return query;
    } catch (error: any) {
      logger.error('Failed to add feedback:', error);
      throw error;
    }
  }

  /**
   * Get query statistics
   */
  async getQueryStats(
    userId: string,
    role: 'mentor' | 'mentee',
    _authToken?: string
  ): Promise<any> {
    try {
      return await queryRepository.getStatsByUserId(userId, role);
    } catch (error: any) {
      logger.error('Failed to fetch query stats:', error);
      throw error;
    }
  }

  /**
   * Mark expired queries
   */
  async markExpiredQueries(): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
      return await queryRepository.markExpired(cutoffDate);
    } catch (error: any) {
      logger.error('Failed to mark expired queries:', error);
      throw error;
    }
  }
}

export default new QueryService();