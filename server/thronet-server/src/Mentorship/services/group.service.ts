// src/Mentorship/services/group.service.ts
import { logger } from "@/shared/logger.util";
import { NotFoundError, BadRequestError, ForbiddenError } from "@/shared/errors/app.error";
import { GroupSession } from "../models";
import { generateSecureId } from "@/shared/security";
import groupRepository from "../repositories/group.repository";
import mentorRepository from "../repositories/mentor.repository";
import cloudinary from '@/config/images/store/cloudinary/cloudinary.config';
import mongoose from 'mongoose';
import { TrustScoreEvents } from '../events/trustScore.events';
import { User } from '@/shared/models/index.models';
import NotificationService, { NotificationType, NotificationChannel } from './notification.service';



interface CreateGroupSessionInput {
  mentorId: string;
  title: string;
  description: string;
  topic: string;
  category?: string;
  scheduledAt: Date;
  duration: number;
  timezone: string;
  maxParticipants: number;
  minParticipants: number;
  pricePerPerson: number;
  agenda?: string;
  outcomes?: string[];
  paymentMethod: string;
  followUp?: {
    allowed: boolean;
    periodDays: number;
  };
  bufferTimeMinutes?: number;
}

class GroupService {
  private async uploadImageToCloudinary(buffer: Buffer, identifier: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'group-session-thumbnails',
          public_id: `group_session_${identifier}_${Date.now()}`,
          resource_type: 'image',
          transformation: [
            { width: 1200, height: 1200, crop: 'limit' },
            { quality: 'auto:good' },
          ],
          overwrite: true,
        },
        (error: any, result: any) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      uploadStream.end(buffer);
    });
  }

  /**
   * Fire-and-forget notifier for every registered participant of a session.
   * Used on start/cancel/complete so mentees are not left in the dark —
   * previously only the mentor ever got notified (on join). Never throws.
   */
  private async notifyParticipants(
    session: any,
    type: NotificationType,
    title: string,
    message: string
  ): Promise<void> {
    try {
      const menteeIds: string[] = (session.participants || [])
        .filter((p: any) => p.attendanceStatus !== 'cancelled')
        .map((p: any) => p.menteeId);

      if (menteeIds.length === 0) return;

      await Promise.all(
        menteeIds.map((menteeId) =>
          NotificationService.sendNotification({
            userId: menteeId,
            type,
            channels: [NotificationChannel.IN_APP],
            data: { title, message },
          }).catch((err: any) => {
            logger.error(`Notification failed for participant ${menteeId}:`, err);
          })
        )
      );
    } catch (err: any) {
      logger.error('notifyParticipants failed:', err);
    }
  }

  async createGroupSession(
    input: CreateGroupSessionInput,
    file?: any,
    authToken?: string
  ): Promise<any> {
    try {
      logger.info(`Creating group session for mentor ${input.mentorId}`);

      const mentor = await mentorRepository.findByUserId(input.mentorId);
      if (!mentor) {
        throw new NotFoundError('Mentor profile not found for this user');
      }

      const scheduledDate = new Date(input.scheduledAt);
      if (scheduledDate <= new Date()) {
        throw new BadRequestError('Scheduled time must be in the future');
      }

      let thumbnailUrl: string | undefined = undefined;
      if (file) {
        thumbnailUrl = await this.uploadImageToCloudinary(file.buffer, input.mentorId);
      }

      const session = new GroupSession({
        sessionId: generateSecureId(),
        mentorId: mentor.mentorId,
        title: input.title,
        description: input.description,
        thumbnailImage: thumbnailUrl,
        topic: input.topic,
        category: input.category,
        scheduledAt: scheduledDate,
        duration: input.duration,
        timezone: input.timezone,
        status: 'open',
        maxParticipants: input.maxParticipants,
        minParticipants: input.minParticipants,
        currentParticipants: 0,
        participants: [],
        pricing: {
          pricePerPerson: input.pricePerPerson,
          currency: 'INR',
          totalRevenue: 0,
        },
        payment: {
          method: input.paymentMethod,
        },
        settings: {
          followUp: {
            allowed: input.followUp?.allowed || false,
            periodDays: input.followUp?.periodDays || 0,
          },
          bufferTimeMinutes: input.bufferTimeMinutes || 0,
        },
        agenda: input.agenda,
        outcomes: input.outcomes,
        chat: {
          enabled: true,
          messageCount: 0,
        },
      });

      await session.save();

      logger.info(`Group session created successfully: ${session._id}`);

      return session;
    } catch (error: any) {
      logger.error(`Failed to create group session:${error}`);
      throw error;
    }
  }

  async getGroupSessionById(sessionId: string, _authToken?: string): Promise<any> {
    try {
      const isObjectId = mongoose.isValidObjectId(sessionId);
      const query = isObjectId ? { $or: [{ _id: sessionId }, { sessionId }] } : { sessionId };

      const session = await GroupSession.findOne(query);
      if (!session) {
        throw new NotFoundError('Group session not found');
      }

      return session;
    } catch (error: any) {
      logger.error(`Failed to fetch group session:${error}`);
      throw error;
    }
  }

  async getAllGroupSessions(
    page: number = 1,
    limit: number = 10,
    filters?: {
      status?: string;
      topic?: string;
      mentorId?: string;
    },
    _authToken?: string
  ): Promise<{
    sessions: any[];
    total: number;
    page: number;
    limit: number;
  }> {
    try {
      const query: any = {};

      if (filters?.status) {
        query.status = filters.status;
      }

      if (filters?.topic) {
        query.topic = new RegExp(filters.topic, 'i');
      }

      if (filters?.mentorId) {
        query.mentorId = filters.mentorId;
      }

      const skip = (page - 1) * limit;

      const [sessions, total] = await Promise.all([
        groupRepository.findAll(query, skip, limit),
        groupRepository.count(query),
      ]);

      return {
        sessions,
        total,
        page,
        limit,
      };
    } catch (error: any) {
      logger.error(`Failed to fetch group sessions:${error}`);
      throw error;
    }
  }

  async getUpcomingGroupSessions(
    mentorId?: string,
    limit: number = 10,
    _authToken?: string
  ): Promise<any[]> {
    try {
      const query: any = {
        scheduledAt: { $gt: new Date() },
        status: { $in: ['open', 'full'] },
      };

      if (mentorId) {
        query.mentorId = mentorId;
      }

      return await groupRepository.findUpcoming(query, limit);
    } catch (error: any) {
      logger.error(`Failed to fetch upcoming group sessions:${error}`);
      throw error;
    }
  }

  async joinGroupSession(
    sessionId: string,
    menteeId: string,
    transactionId?: string,
    authToken?: string
  ): Promise<any> {
    try {
      const session = await this.getGroupSessionById(sessionId, authToken);

      if (session.status !== 'open') {
        throw new BadRequestError('Session is not open for registration');
      }

      const isRegistered = session.participants.some(
        (p: any) => p.menteeId === menteeId
      );

      if (isRegistered) {
        throw new BadRequestError('Already registered for this session');
      }

      await session.addParticipant(menteeId, transactionId);

      logger.info(`User ${menteeId} joined group session: ${sessionId}`);

      (async () => {
        try {
          const [mentorProfile, mentee] = await Promise.all([
            mentorRepository.findByMentorId(session.mentorId),
            User.findOne({ userId: menteeId, 'flags.isDeleted': false }).select('fullName email'),
          ]);

          if (!mentorProfile?.userId) {
            logger.warn(`Could not resolve mentor userId for group session notification: ${session.mentorId}`);
            return;
          }

          const menteeName = mentee?.fullName || mentee?.email || 'A mentee';

          await NotificationService.sendNotification({
            userId: mentorProfile.userId,
            type: NotificationType.BOOKING_CONFIRMED,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'New Group Session Signup',
              message: `${menteeName} joined your group session "${session.title}". ${session.currentParticipants}/${session.maxParticipants} seats filled.`,
            },
          });
        } catch (notifyErr: any) {
          logger.error('Notification failed (joinGroupSession → mentor):', notifyErr);
        }
      })();

      (async () => {
        try {
          await NotificationService.sendNotification({
            userId: menteeId,
            type: NotificationType.BOOKING_CONFIRMED,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'Seat Reserved',
              message: `You're registered for "${session.title}" on ${new Date(session.scheduledAt).toLocaleString()}.`,
            },
          });
        } catch (notifyErr: any) {
          logger.error('Notification failed (joinGroupSession → mentee):', notifyErr);
        }
      })();

      return session;
    } catch (error: any) {
      logger.error(`Failed to join group session:${error}`);
      throw error;
    }
  }

  async leaveGroupSession(
    sessionId: string,
    menteeId: string,
    authToken?: string
  ): Promise<any> {
    try {
      const session = await this.getGroupSessionById(sessionId, authToken);

      const participant = session.participants.find(
        (p: any) => p.menteeId === menteeId
      );

      if (!participant) {
        throw new BadRequestError('Not registered for this session');
      }

      const hoursDiff = (session.scheduledAt.getTime() - Date.now()) / (1000 * 60 * 60);

      if (hoursDiff < 24) {
        throw new BadRequestError('Cannot leave within 24 hours of session');
      }

      await session.removeParticipant(menteeId);

      logger.info(`User ${menteeId} left group session: ${sessionId}`);

      (async () => {
        try {
          const mentorProfile = await mentorRepository.findByMentorId(session.mentorId);
          if (!mentorProfile?.userId) return;

          await NotificationService.sendNotification({
            userId: mentorProfile.userId,
            // ✅ FIXED: was NotificationType.BOOKING_CANCELLED (doesn't exist)
            type: NotificationType.SESSION_CANCELLED,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'Group Session Seat Freed',
              message: `A mentee left "${session.title}". ${session.currentParticipants}/${session.maxParticipants} seats filled.`,
            },
          });
        } catch (notifyErr: any) {
          logger.error('Notification failed (leaveGroupSession → mentor):', notifyErr);
        }
      })();

      // TODO: Process refund

      return session;
    } catch (error: any) {
      logger.error(`Failed to leave group session: ${error}`);
      throw error;
    }
  }

  async startGroupSession(
    sessionId: string,
    mentorId: string,
    authToken?: string
  ): Promise<any> {
    try {
      const mentor = await mentorRepository.findByUserId(mentorId);
      if (!mentor) throw new ForbiddenError('Mentor profile not found');

      const session = await this.getGroupSessionById(sessionId, authToken);

      if (session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the mentor can start this session');
      }

      if (session.currentParticipants < session.minParticipants) {
        throw new BadRequestError(
          `Minimum ${session.minParticipants} participants required`,
        );
      }

      await session.startSession();

      logger.info(`Group session started: ${sessionId}`);

      await this.notifyParticipants(
        session,
        NotificationType.SESSION_STARTED,
        'Group Session Started',
        `"${session.title}" has started. Join now.`
      );

      return session;
    } catch (error: any) {
      logger.error(`Failed to start group session:${error}`);
      throw error;
    }
  }

  async completeGroupSession(
    sessionId: string,
    mentorId: string,
    actualDuration?: number,
    attendees?: string[],
    authToken?: string
  ): Promise<any> {
    try {
      const session = await this.getGroupSessionById(sessionId, authToken);

      const mentor = await mentorRepository.findByUserId(mentorId);
      if (!mentor) throw new ForbiddenError('Mentor profile not found');

      if (session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the mentor can complete this session');
      }

      if (attendees && attendees.length > 0) {
        session.participants.forEach((p: any) => {
          p.attendanceStatus = attendees.includes(p.menteeId) ? 'attended' : 'absent';
        });
      }

      await session.completeSession(actualDuration);

      TrustScoreEvents.emit('GroupSessionCompleted', {
        mentorId: session.mentorId,
        sessionId,
        timestamp: new Date()
      });

      logger.info(`Group session completed: ${sessionId}`);

      await this.notifyParticipants(
        session,
        NotificationType.SESSION_COMPLETED,
        'Session Completed',
        `"${session.title}" has ended. Please share your feedback.`
      );

      return session;
    } catch (error: any) {
      logger.error(`Failed to complete group session:${error}`);
      throw error;
    }
  }

  async cancelGroupSession(
    sessionId: string,
    mentorId: string,
    reason: string,
    authToken?: string
  ): Promise<any> {
    try {
      const session = await this.getGroupSessionById(sessionId, authToken);

      const mentor = await mentorRepository.findByUserId(mentorId);
      if (!mentor) throw new ForbiddenError('Mentor profile not found');

      if (session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the mentor can cancel this session');
      }

      await session.cancelSession(reason);

      TrustScoreEvents.emit('GroupSessionCancelled', {
        mentorId: session.mentorId,
        sessionId,
        timestamp: new Date()
      });

      logger.info(`Group session cancelled: ${sessionId}`);

      await this.notifyParticipants(
        session,
        // ✅ FIXED: was NotificationType.BOOKING_CANCELLED (doesn't exist)
        NotificationType.SESSION_CANCELLED,
        'Group Session Cancelled',
        `"${session.title}" was cancelled by the mentor. Reason: ${reason}`
      );

      // TODO: Process refunds for all participants (payment gateway not wired yet)

      return session;
    } catch (error: any) {
      logger.error(`Failed to cancel group session:${error}`);
      throw error;
    }
  }

  async updateGroupSession(
    sessionId: string,
    userId: string,
    updates: Partial<any>,
    file?: any,
    authToken?: string
  ): Promise<any> {
    try {
      logger.info(`Updating group session ${sessionId} by user ${userId}`);

      const isObjectId = mongoose.isValidObjectId(sessionId);
      const query = isObjectId ? { $or: [{ _id: sessionId }, { sessionId }] } : { sessionId };
      const session = await GroupSession.findOne(query);

      if (!session) {
        throw new NotFoundError('Group session not found');
      }

      const mentor = await mentorRepository.findByUserId(userId);
      if (!mentor || session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the host mentor can update this session');
      }

      const updatePayload: any = { $set: {} };

      if (file) {
        updatePayload.$set.thumbnailImage = await this.uploadImageToCloudinary(file.buffer, sessionId);
      }

      if (updates.title) updatePayload.$set.title = updates.title;
      if (updates.description) updatePayload.$set.description = updates.description;
      if (updates.topic) updatePayload.$set.topic = updates.topic;
      if (updates.category) updatePayload.$set.category = updates.category;
      if (updates.scheduledAt) updatePayload.$set.scheduledAt = new Date(updates.scheduledAt);
      if (updates.duration !== undefined) updatePayload.$set.duration = Number(updates.duration);
      if (updates.timezone) updatePayload.$set.timezone = updates.timezone;
      if (updates.maxParticipants !== undefined) updatePayload.$set.maxParticipants = Number(updates.maxParticipants);
      if (updates.minParticipants !== undefined) updatePayload.$set.minParticipants = Number(updates.minParticipants);

      if (updates.pricePerPerson !== undefined) {
        updatePayload.$set['pricing.pricePerPerson'] = Number(updates.pricePerPerson);
      }

      if (updates.paymentMethod) {
        updatePayload.$set['payment.method'] = updates.paymentMethod;
      }

      if (updates.followUp !== undefined) {
        updatePayload.$set['settings.followUp'] = updates.followUp;
      }

      if (updates.bufferTimeMinutes !== undefined) {
        updatePayload.$set['settings.bufferTimeMinutes'] = Number(updates.bufferTimeMinutes);
      }

      if (updates.status) {
        updatePayload.$set.status = updates.status;
      }

      const updatedSession = await GroupSession.findOneAndUpdate(
        query,
        updatePayload,
        { new: true, runValidators: true }
      );

      if (!updatedSession) {
        throw new Error("findOneAndUpdate failed to return document");
      }

      logger.info(`Group session updated successfully: ${session.sessionId}`);
      return updatedSession;
    } catch (error: any) {
      logger.error(`Failed to update group session: ${error.message}`);
      throw error;
    }
  }

  async deleteGroupSession(sessionId: string, userId: string, authToken?: string): Promise<void> {
    try {
      const session = await this.getGroupSessionById(sessionId, authToken);

      const mentor = await mentorRepository.findByUserId(userId);
      if (!mentor || session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the host mentor can delete this session');
      }

      if (session.currentParticipants > 0) {
        throw new BadRequestError('Cannot delete a session with registered participants. Cancel it first.');
      }

      const isObjectId = mongoose.isValidObjectId(sessionId);
      const query = isObjectId ? { $or: [{ _id: sessionId }, { sessionId }] } : { sessionId };
      await GroupSession.deleteOne(query);

      logger.info(`Group session deleted: ${sessionId}`);
    } catch (error: any) {
      logger.error(`Failed to delete group session: ${error.message}`);
      throw error;
    }
  }

  async addFeedback(
    sessionId: string,
    menteeId: string,
    rating: number,
    comment?: string,
    authToken?: string
  ): Promise<any> {
    try {
      const session = await this.getGroupSessionById(sessionId, authToken);

      if (session.status !== 'completed') {
        throw new BadRequestError('Can only provide feedback for completed sessions');
      }

      const participant = session.participants.find(
        (p: any) => p.menteeId === menteeId && p.attendanceStatus === 'attended'
      );

      if (!participant) {
        throw new ForbiddenError('Only attendees can provide feedback');
      }

      await session.addFeedback(menteeId, rating, comment);

      logger.info(`Feedback added for group session: ${sessionId}`);

      return session;
    } catch (error: any) {
      logger.error(`Failed to add feedback:${error}`);
      throw error;
    }
  }

  async getMyGroupSessions(
    userId: string,
    role: 'mentor' | 'mentee',
    _authToken?: string
  ): Promise<any[]> {
    try {
      if (role === 'mentor') {
        const mentor = await mentorRepository.findByUserId(userId);
        const mentorIdQuery = mentor ? [mentor.mentorId, userId] : [userId];
        return await GroupSession.find({ mentorId: { $in: mentorIdQuery } })
          .sort({ scheduledAt: -1 })
          .lean();
      }
      return await groupRepository.findByUserId(userId, role);
    } catch (error: any) {
      logger.error(`Failed to fetch my group sessions: ${error}`);
      throw error;
    }
  }

  /**
   * Group-session participants across a mentor's sessions, enriched into
   * the same row shape BookingsPage.tsx already uses for 1:1 bookings —
   * this is what's needed to make group joins show up as actionable rows
   * in the mentor's Booking dashboard (currently they don't show up there
   * at all, only as a bare count on the Services tab).
   */
  async getGroupSessionParticipantsForMentor(userId: string): Promise<any[]> {
    try {
      const mentor = await mentorRepository.findByUserId(userId);
      const mentorIdQuery = mentor ? [mentor.mentorId, userId] : [userId];

      const sessions = await GroupSession.find({ mentorId: { $in: mentorIdQuery } })
        .sort({ scheduledAt: -1 })
        .lean();

      const rows: any[] = [];

      for (const session of sessions) {
        for (const participant of (session as any).participants || []) {
          rows.push({
            bookingId: `${session.sessionId}-${participant.menteeId}`,
            sessionId: session.sessionId,
            menteeId: participant.menteeId,
            serviceName: `${session.title} (Group Session)`,
            scheduledAt: session.scheduledAt,
            status:
              session.status === 'cancelled'
                ? 'cancelled'
                : participant.attendanceStatus === 'attended'
                ? 'completed'
                : session.status === 'in_progress'
                ? 'in_progress'
                : 'confirmed',
            isGroupSession: true,
            registeredAt: participant.registeredAt,
            paymentStatus: participant.paymentStatus,
          });
        }
      }

      return rows;
    } catch (error: any) {
      logger.error(`Failed to fetch group session participants for mentor: ${error}`);
      throw error;
    }
  }

  
}

const groupService = new GroupService();
export default groupService;