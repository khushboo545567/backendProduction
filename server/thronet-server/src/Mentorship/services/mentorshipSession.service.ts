import mentorService from './mentor.service';
import { SESSION_DURATIONS, SessionType } from '@/shared/constants/sessionTypes';
import { PaymentMethod, PaymentStatus, ISessionMentor } from '@/Mentorship/interface/session.types';
import { Types } from 'mongoose';
import { Mentor, SessionMentor } from '../models';
import availabilityService from './availability.service';
import { computeEndTime, toMinutes, toTimeString } from '@/Mentorship/utils/slotSplitter';
import { logger } from '@/shared/logger.util';
import { BadRequestError, ForbiddenError, NotFoundError } from '@/shared/errors/app.error';
import { TrustScoreEvents } from '../events/trustScore.events';
import NotificationService, { NotificationType, NotificationChannel } from './notification.service';
import { emitToUser } from '@/socket';
import { User } from '@/shared/models/index.models';
import { BookingStatus, isStartAllowed } from '@/shared/constants/bookingStatus';
import sessionRepository from '../repositories/session.repository';
import mentorRepository from '../repositories/mentor.repository';
import cloudinary from '@/config/images/store/cloudinary/cloudinary.config';

interface CreateSessionInput {
  mentorId: string;
  menteeId: string;
  sessionType: SessionType;
  scheduledAt: Date;
  timezone: string;
  title: string;
  description?: string;
  notes?: string;
  paymentMethod: PaymentMethod;
  pricing: {
    basePrice: number;
    platformFee: number;
    totalAmount: number;
    currency?: string;
  };
}

interface SessionFilters {
  status?: string;
  sessionType?: SessionType;
  startDate?: Date;
  endDate?: Date;
}

class MentorshipSessionService {
  private async uploadImageToCloudinary(buffer: Buffer, sessionId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'session-thumbnails',
          public_id: `session_${sessionId}_${Date.now()}`,
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

  async createSession(input: CreateSessionInput, authToken?: string): Promise<any> {
    try {
      logger.info(`Creating session: ${input.sessionType}`);

      const mentor = await mentorRepository.findByMentorId(input.mentorId);
      if (!mentor) throw new NotFoundError('MENTOR_NOT_FOUND');

      const user = await User.findOne({ userId: input.menteeId, 'flags.isDeleted': false });
      if (!user) throw new NotFoundError('MENTEE_NOT_FOUND');

      const existingSession = await SessionMentor.findOne({
        mentorId: input.mentorId,
        menteeId: input.menteeId,
        scheduledAt: new Date(input.scheduledAt),
        status: { $nin: ['cancelled', 'no_show', 'refunded'] },
      });
      if (existingSession) {
        throw new BadRequestError(
          'You already have a booking with this mentor for this date and time.'
        );
      }

      const duration = SESSION_DURATIONS[input.sessionType];
      const isFree   = input.paymentMethod === PaymentMethod.FREE;

      const basePrice   = isFree ? 0 : input.pricing.basePrice;
      const platformFee = isFree ? 0 : input.pricing.platformFee;
      const totalAmount = isFree ? 0 : input.pricing.totalAmount;
      const currency    = input.pricing?.currency || 'INR';

      if (!isFree) {
        const priceKey = this.mapSessionTypeToPrice(input.sessionType);
        await mentorRepository.updateByMentorId(input.mentorId, {
          [`pricing.${String(priceKey)}`]: basePrice,
        });
      }

      const sessionData = {
        mentorId: input.mentorId,
        menteeId: input.menteeId,
        sessionType: input.sessionType,
        status: BookingStatus.PENDING,
        scheduledAt: new Date(input.scheduledAt),
        duration,
        timezone: input.timezone,
        title: input.title,
        description: input.description,
        notes: input.notes,
        pricing: { basePrice, platformFee, totalAmount, currency },
        payment: {
          status: isFree ? PaymentStatus.COMPLETED : PaymentStatus.PENDING,
          method: input.paymentMethod,
        },
        reschedule: { count: 0, previousDates: [] },
      };

      const session = await sessionRepository.create(sessionData);
      logger.info(`✅ Session created: ${session.sessionId}`);
      return session;
    } catch (error: any) {
      logger.error(`Failed to create session: ${error.message}`);
      throw error;
    }
  }

  async createMentorSession(mentorUserId: string, input: any, file?: any): Promise<any> {
    try {
      logger.info(`Creating mentor session template by: ${mentorUserId}`);

      const mentor = await Mentor.findOne({ userId: mentorUserId, isDeleted: false });
      if (!mentor) throw new NotFoundError('Mentor profile not found');

      if (file) {
        input.thumbnailImage = await this.uploadImageToCloudinary(file.buffer, mentorUserId);
      }

      const sessionData = {
        mentorId: mentor.mentorId,
        menteeId: null,
        status: BookingStatus.AVAILABLE,
        sessionType: input.sessionType,
        scheduledAt: new Date(input.scheduledAt),
        duration: input.duration,
        timezone: input.timezone,
        title: input.title,
        description: input.description,
        thumbnailImage: input.thumbnailImage,
        pricing: {
          basePrice: input.pricing.basePrice,
          platformFee: input.pricing.platformFee || 0,
          totalAmount: input.pricing.totalAmount,
          currency: input.pricing.currency || 'INR',
        },
        payment: {
          status: PaymentStatus.PENDING,
          method: input.paymentMethod,
        },
        reschedule: { count: 0, previousDates: [] },
      };

      const session = await sessionRepository.create(sessionData);
      logger.info(`✅ Mentor session template created: ${session.sessionId}`);
      return session;
    } catch (error: any) {
      logger.error(`Failed to create mentor session: ${error.message}`);
      throw error;
    }
  }

  async getMentorAssignedSessions(mentorId: string): Promise<any[]> {
    try {
      logger.info(`Fetching assigned sessions for mentor: ${mentorId}`);

      const sessions = (await SessionMentor.find({ mentorId })
        .sort({ scheduledAt: 1 })
        .lean()) as unknown as ISessionMentor[];

      const userIds = new Set<string>();

      sessions.forEach((session: ISessionMentor) => {
        if (session.menteeId) {
          userIds.add(session.menteeId);
        }
        if (session.bookings && Array.isArray(session.bookings)) {
          session.bookings.forEach((booking: any) => {
            if (booking.menteeId) userIds.add(booking.menteeId);
            if (booking.bookedBy) userIds.add(booking.bookedBy);
          });
        }
      });

      if (userIds.size === 0) {
        return sessions;
      }

      const users = await User.find({ userId: { $in: Array.from(userIds) } })
        .select('userId firstName lastName email profilePhotoId')
        .lean();

      interface EnrichedMentee {
        userId: string;
        fullName: string;
        email: string;
        profilePic: string;
      }
      type SessionBooking = NonNullable<ISessionMentor['bookings']>[0];
      interface EnrichedBooking extends SessionBooking {
        mentee?: EnrichedMentee;
      }
      interface EnrichedSession extends Omit<ISessionMentor, 'bookings'> {
        mentee?: EnrichedMentee;
        bookings?: EnrichedBooking[];
      }

      const userMap = new Map<string, EnrichedMentee>();
      users.forEach((u: any) => {
        userMap.set(u.userId, {
          userId: u.userId,
          fullName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          email: u.email,
          profilePic: u.profilePhotoId
        });
      });

      const enrichedSessions = sessions.map((session: ISessionMentor) => {
        const enriched: EnrichedSession = { ...session };

        if (session.menteeId && userMap.has(session.menteeId)) {
          enriched.mentee = userMap.get(session.menteeId);
        }

        if (session.bookings && Array.isArray(session.bookings)) {
          enriched.bookings = session.bookings.map((booking: SessionBooking) => {
            const bEnriched: EnrichedBooking = { ...booking };
            const targetId = booking.bookedBy || booking.menteeId;
            if (targetId && userMap.has(targetId)) {
              bEnriched.mentee = userMap.get(targetId);
            }
            return bEnriched;
          });
        }

        return enriched;
      });

      return enrichedSessions;
    } catch (error: any) {
      logger.error(`Failed to fetch mentor assigned sessions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Book an existing mentor-posted session slot.
   */
  async bookSession(input: any, authToken?: string): Promise<any> {
    try {
      // ✅ FIX: removed debug console.log that dumped the full `input`
      // object (including payment/pricing details) to server logs in
      // production. Use logger.info with a trimmed line instead.
      logger.info(`Booking session: ${input.sessionId} by mentee: ${input.menteeId}`);

      let query: any = { sessionId: input.sessionId };
      if (Types.ObjectId.isValid(input.sessionId)) {
        query = {
          $or: [
            { sessionId: input.sessionId },
            { _id: new Types.ObjectId(input.sessionId) }
          ]
        };
      }
      let session = await SessionMentor.findOne(query);
      if (!session) throw new NotFoundError('Session not found');

      if (
        session.status === BookingStatus.CANCELLED ||
        session.status === BookingStatus.NO_SHOW ||
        session.status === BookingStatus.REFUNDED
      ) {
        throw new BadRequestError('Session is not available for booking');
      }

      if (session.mentorId !== input.mentorId) {
        throw new BadRequestError('Session does not belong to this mentor');
      }

      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      const [rawStart, rawEnd] = String(input.slotTime).split(' - ').map((t: string) => t.trim());
      if (!rawStart || !timeRegex.test(rawStart)) {
        throw new BadRequestError('Invalid slot time');
      }
      const slotStart = toTimeString(toMinutes(rawStart));
      const slotEnd = Number(session.duration) > 0
        ? computeEndTime(rawStart, Number(session.duration))
        : rawEnd;
      if (!slotEnd || !timeRegex.test(slotEnd)) {
        throw new BadRequestError('Invalid slot time');
      }

      const bookedRange = await availabilityService.bookRange(
        input.availabilityId,
        input.mentorId,
        slotStart,
        slotEnd,
        session.sessionId
      );
      if (!bookedRange) {
        throw new BadRequestError('This time slot is no longer available. Please pick another slot.');
      }

      const updatedSession = await SessionMentor.findOneAndUpdate(
        {
          sessionId: session.sessionId,
          status: { $nin: [BookingStatus.CANCELLED, BookingStatus.NO_SHOW, BookingStatus.REFUNDED] },
          bookings: {
            $not: { $elemMatch: { menteeId: input.menteeId, status: { $ne: 'cancelled' } } },
          },
        },
        {
          $push: {
            bookings: {
              menteeId:       input.menteeId,
              bookedBy:       input.menteeId,
              bookedAt:       new Date(),
              status:         'pending',
              slotTime:       `${slotStart} - ${slotEnd}`,
              scheduledAt:    new Date(input.scheduledAt),
              availabilityId: input.availabilityId,
              payment: {
                status: PaymentStatus.PENDING,
                method: input.paymentMethod,
              },
              pricing: {
                basePrice:   input.pricing.basePrice,
                platformFee: input.pricing.platformFee,
                totalAmount: input.pricing.totalAmount,
                currency:    input.pricing.currency || 'INR',
              },
            } as any,
          },
          $set: {
            menteeId: input.menteeId,
            bookedBy: input.menteeId,
            bookedAt: new Date(),
            isBooked: true,
          },
        },
        { new: true }
      );

      if (!updatedSession) {
        await availabilityService.releaseRange(input.availabilityId, slotStart, slotEnd);
        throw new BadRequestError('You have already booked this session for this date and time.');
      }

      session = updatedSession;

      logger.info(`✅ Booking added: ${session.sessionId} for mentee: ${input.menteeId}`);

      try {
        const [mentorDoc, menteeDoc] = await Promise.all([
          Mentor.findOne({ mentorId: session.mentorId, isDeleted: false }),
          User.findOne({ userId: input.menteeId }),
        ]);

        const menteeName =
          menteeDoc?.fullName ||
          `${menteeDoc?.firstName || ''} ${menteeDoc?.lastName || ''}`.trim() ||
          menteeDoc?.email ||
          'A user';

        if (mentorDoc?.userId) {
          NotificationService.sendNotification({
            userId: mentorDoc.userId,
            type: NotificationType.NEW_BOOKING_REQUEST,
            channels: [NotificationChannel.IN_APP],
            data: {
              menteeId: input.menteeId,
              menteeName,
            
              title: 'New Booking Request',
              message: `${menteeName} sent a new booking request for "${session.title}".`,
            },
          }).catch((e) => logger.error('Notification failed (bookSession → mentor):', e));
        }

        NotificationService.sendNotification({
          userId: input.menteeId,
          type: NotificationType.BOOKING_CONFIRMED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'Booking Request Sent',
            message: `Your booking request for "${session.title}" has been sent to the mentor.`,
          },
        }).catch((e) => logger.error('Notification failed (bookSession → mentee):', e));

        if (input.paymentMethod !== PaymentMethod.FREE) {
          NotificationService.sendNotification({
            userId: input.menteeId,
            type: NotificationType.PAYMENT_SUCCESS,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'Payment Successful',
              message: `Your payment of ₹${input.pricing.totalAmount} for "${session.title}" was successful.`,
              amount: input.pricing.totalAmount,
              transactionId: session.sessionId,
            },
          }).catch((e) => logger.error('Notification failed (bookSession → payment):', e));
        }
      } catch (notifErr: any) {
        logger.warn(`⚠️ Failed to send booking-request notification: ${notifErr.message}`);
      }

      const bookings = session.bookings ?? [];
      const myBooking = bookings[bookings.length - 1];
      return {
        sessionId:     session.sessionId,
        mentorId:      session.mentorId,
        title:         session.title,
        sessionType:   session.sessionType,
        duration:      session.duration,
        booking:       myBooking,
        totalBookings: bookings.length,
      };
    } catch (error: any) {
      // ✅ FIX: removed debug console.log dump of the raw error object
      logger.error(`Failed to book session: ${error.message}`);
      throw error;
    }
  }

  async getSessionProgress(sessionId: string, userId: string): Promise<any> {
    try {
      const sessions = (await SessionMentor.find({
        $or: [{ menteeId: userId }, { mentorId: userId }],
      }).lean()) as unknown as ISessionMentor[];

      const total     = sessions.length;
      const completed = sessions.filter((s: ISessionMentor) => s.status === BookingStatus.COMPLETED).length;
      const left      = sessions.filter((s: ISessionMentor) => s.completion?.leftAt !== undefined).length;
      const totalTimeSpent = sessions
        .filter((s: ISessionMentor) => s.completion?.actualDuration)
        .reduce((acc: number, s: ISessionMentor) => acc + (s.completion?.actualDuration || 0), 0);

      return {
        totalSessionsBooked:   total,
        completedSessions:     completed,
        leftSessions:          left,
        totalTimeSpentMinutes: totalTimeSpent,
        completionRate:        total > 0 ? Math.round((completed / total) * 100) : 0,
      };
    } catch (error: any) {
      logger.error(`Failed to fetch session progress: ${error.message}`);
      throw error;
    }
  }

  async getSessionById(
    sessionId: string,
    userId?: string,
    _authToken?: string
  ): Promise<any> {
    try {
      logger.info(`Fetching session: ${sessionId}`);

      const session = await SessionMentor.findOne({ sessionId });
      if (!session) throw new NotFoundError('Session not found');

      if (userId) {
        const mentor  = await Mentor.findOne({ userId, isDeleted: false });
        const isMentor = mentor && session.mentorId === mentor.mentorId;
        const isMentee = session.menteeId === userId || (session.bookings && session.bookings.some((b: any) => b.menteeId === userId));

        if (!isMentor && !isMentee) {
          throw new ForbiddenError('You are not authorized to view this session');
        }
      }

      return session;
    } catch (error: any) {
      logger.error(`Failed to fetch session: ${error.message}`);
      throw error;
    }
  }

  async getAllSessions(
    userId: string,
    role: 'mentor' | 'mentee',
    page: number = 1,
    limit: number = 10,
    filters?: SessionFilters,
    _authToken?: string
  ): Promise<any> {
    try {
      const query: any = {};

      if (role === 'mentor') {
        const mentor = await Mentor.findOne({ userId, isDeleted: false });
        if (!mentor) throw new NotFoundError('MENTOR_NOT_FOUND');
        query.mentorId = mentor.mentorId;
      } else {
        query['bookings.menteeId'] = userId;
      }

      if (filters?.status)      query.status      = filters.status;
      if (filters?.sessionType) query.sessionType  = filters.sessionType;
      if (filters?.startDate || filters?.endDate) {
        query.scheduledAt = {};
        if (filters.startDate) query.scheduledAt.$gte = filters.startDate;
        if (filters.endDate)   query.scheduledAt.$lte = filters.endDate;
      }

      const skip = (page - 1) * limit;

      const { data: sessions, total } = await sessionRepository.findAll(query, skip, limit);

      return { sessions, total, page, limit };
    } catch (error: any) {
      logger.error(`Failed to fetch sessions: ${error.message}`);
      throw error;
    }
  }

  async getAllSessionsFromDB(page: number = 1, limit: number = 10): Promise<any> {
    try {
      logger.info('Fetching all sessions from database');
      const skip = (page - 1) * limit;

      const { data: sessions, total } = await sessionRepository.findAll({}, skip, limit);
      return { sessions, total, page, limit };
    } catch (error: any) {
      logger.error(`Failed to fetch all sessions: ${error.message}`);
      throw error;
    }
  }

  async getUpcomingSessions(
    userId: string,
    role: 'mentor' | 'mentee',
    limit: number = 10,
    _authToken?: string
  ): Promise<any[]> {
    try {
      const query: any = {
        scheduledAt: { $gt: new Date() },
        status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      };

      if (role === 'mentor') {
        const mentor = await Mentor.findOne({ userId, isDeleted: false });
        if (!mentor) throw new NotFoundError('MENTOR_NOT_FOUND');
        query.mentorId = mentor.mentorId;
      } else {
        query['bookings.menteeId'] = userId;
      }

      const { data } = await sessionRepository.findAll(query, 0, limit, 1);
      return data;
    } catch (error: any) {
      logger.error(`Failed to fetch upcoming sessions: ${error.message}`);
      throw error;
    }
  }

  async getPastSessions(
    userId: string,
    role: 'mentor' | 'mentee',
    limit: number = 10,
    _authToken?: string
  ): Promise<any[]> {
    try {
      const query: any = {
        scheduledAt: { $lt: new Date() },
        status: BookingStatus.COMPLETED,
      };

      if (role === 'mentor') {
        const mentor = await Mentor.findOne({ userId, isDeleted: false });
        if (!mentor) throw new NotFoundError('MENTOR_NOT_FOUND');
        query.mentorId = mentor.mentorId;
      } else {
        query['bookings.menteeId'] = userId;
      }

      const { data } = await sessionRepository.findAll(query, 0, limit);
      return data;
    } catch (error: any) {
      logger.error(`Failed to fetch past sessions: ${error.message}`);
      throw error;
    }
  }

  async updateSession(
    sessionId: string,
    userId: string,
    updates: Partial<any>,
    authToken?: string,
    file?: any
  ): Promise<any> {
    try {
      await this.getSessionById(sessionId, userId, authToken);

      if (file) {
        updates.thumbnailImage = await this.uploadImageToCloudinary(file.buffer, userId);
      }

      const allowedUpdates = ['notes', 'description', 'title', 'thumbnailImage', 'scheduledAt', 'duration', 'pricing', 'followUp', 'bufferTimeMinutes'];
      const isValidUpdate  = Object.keys(updates).every((key) => allowedUpdates.includes(key));

      if (!isValidUpdate) {
        throw new BadRequestError('Invalid update fields. Only notes, description, title, thumbnailImage, scheduledAt, duration, pricing, followUp, bufferTimeMinutes are allowed.');
      }

      if (updates.scheduledAt) {
        updates.scheduledAt = new Date(updates.scheduledAt);
      }

      const updatedSession = await SessionMentor.findOneAndUpdate(
        { sessionId },
        { $set: updates },
        { new: true, runValidators: false }
      );

      if (!updatedSession) {
        throw new NotFoundError('Session not found after update');
      }

      return updatedSession;
    } catch (error: any) {
      logger.error(`Failed to update session: ${error.message}`);
      throw error;
    }
  }

  async deleteSession(sessionId: string, userId: string, authToken?: string): Promise<void> {
    try {
      const session = await this.getSessionById(sessionId, userId, authToken);

      const mentor = await Mentor.findOne({ userId, isDeleted: false });
      if (!mentor || session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the mentor of this session can delete it');
      }

      const hasActiveBooking = (session.bookings || []).some(
        (b: any) => b.status !== BookingStatus.CANCELLED
      );
      if (hasActiveBooking) {
        throw new BadRequestError('Cannot delete a session with active bookings. Cancel the bookings first.');
      }

      await SessionMentor.deleteOne({ sessionId });
      logger.info(`Session deleted: ${sessionId}`);
    } catch (error: any) {
      logger.error(`Failed to delete session: ${error.message}`);
      throw error;
    }
  }

  async confirmSession(
    sessionId: string,
    userId: string,
    authToken?: string,
    bookingId?: string
  ): Promise<any> {
    try {
      const session = await this.getSessionById(sessionId, userId, authToken);

      const mentor = await Mentor.findOne({ userId });
      if (!mentor || session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the mentor of this session can confirm bookings');
      }

      if (!bookingId) {
        throw new BadRequestError('bookingId is required to confirm a session booking');
      }

      const booking = session.bookings?.find((b: any) => b._id?.toString() === bookingId);
      if (!booking) {
        const available = session.bookings?.map((b: any) => b._id?.toString());
        throw new BadRequestError(`Booking not found. Expected: ${bookingId}, Available: ${JSON.stringify(available)}`);
      }
      if (booking.status !== 'pending') {
        throw new BadRequestError(`Booking is not pending. Current status: ${booking.status}`);
      }

      await SessionMentor.updateOne(
        { sessionId, 'bookings._id': bookingId },
        {
          $set: {
            'bookings.$.status': BookingStatus.CONFIRMED,
            status: BookingStatus.CONFIRMED
          }
        }
      );

      logger.info(`Session confirmed: ${sessionId}, bookedBy/bookingId: ${bookingId}`);

      const menteeIdToNotify = booking.menteeId || booking.bookedBy;
      if (menteeIdToNotify) {
        NotificationService.sendNotification({
          userId: menteeIdToNotify,
          type: NotificationType.BOOKING_CONFIRMED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'Booking Confirmed',
            message: `Your session "${session.title}" has been confirmed by the mentor.`,
          },
        }).catch((e) => logger.error('Notification failed (confirmSession):', e));
      }

      return await SessionMentor.findOne({ sessionId });
    } catch (error: any) {
      logger.error(`Failed to confirm session (${sessionId}): ${error.message}`);
      throw error;
    }
  }

  async startSession(
    sessionId: string,
    userId: string,
    authToken?: string,
    bookingId?: string
  ): Promise<any> {
    try {
      logger.info(`Starting session: ${sessionId}, booking: ${bookingId}`);

      const session = await this.getSessionById(sessionId, userId, authToken);

      const mentor = await Mentor.findOne({ userId, isDeleted: false });
      if (!mentor || session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the mentor of this session can start it');
      }

      let targetBooking: any = null;
      if (bookingId) {
        targetBooking = session.bookings?.find((b: any) => b._id?.toString() === bookingId);
        if (!targetBooking) throw new NotFoundError('Booking not found on this session');
      } else {
        const confirmed = (session.bookings || []).filter((b: any) =>
          b.status === BookingStatus.CONFIRMED || b.status === BookingStatus.RESCHEDULED
        );
        if (confirmed.length > 1) {
          throw new BadRequestError('Multiple bookings found on this session — bookingId is required');
        }
        targetBooking = confirmed[0] || null;
      }

      if (!targetBooking || (targetBooking.status !== BookingStatus.CONFIRMED && targetBooking.status !== BookingStatus.RESCHEDULED)) {
        throw new BadRequestError('Booking must be confirmed before starting');
      }

      const bookingScheduledAt = targetBooking.scheduledAt || session.scheduledAt;
      if (!isStartAllowed(bookingScheduledAt)) {
        const isTooEarly = Date.now() < new Date(bookingScheduledAt).getTime();
        const err: any = new Error(
          isTooEarly ? 'Session cannot be started yet — too early.' : 'Session start window has expired.'
        );
        err.code = isTooEarly ? 'TOO_EARLY' : 'WINDOW_EXPIRED';
        throw err;
      }

      const startedAtNow = new Date();
      await SessionMentor.updateOne(
        { sessionId, 'bookings._id': targetBooking._id },
        {
          $set: {
            'bookings.$.status': BookingStatus.IN_PROGRESS,
            'bookings.$.startedAt': startedAtNow,
            status: BookingStatus.IN_PROGRESS,
            startedAt: startedAtNow,
          },
        }
      );

      const updatedSession = await SessionMentor.findOne({ sessionId });
      logger.info(`Session started: ${sessionId}, booking: ${targetBooking._id}`);

      const menteeIdToNotify = targetBooking.menteeId || targetBooking.bookedBy;
      if (menteeIdToNotify) {
        NotificationService.sendNotification({
          userId: menteeIdToNotify,
          type: NotificationType.SESSION_STARTED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'Session Started',
            message: `Your session "${session.title}" has started. Join now!`,
          },
        }).catch((e) => logger.error('Notification failed (startSession):', e));

        try {
          const payload = {
            sessionId: session.sessionId,
            bookingId: targetBooking._id?.toString(),
            roomId: targetBooking._id?.toString(),
            title: session.title,
            startedAt: startedAtNow,
            scheduledAt: targetBooking.scheduledAt || session.scheduledAt,
            meetingUrl: session.meeting?.meetingUrl || null,
          };
          emitToUser(menteeIdToNotify, 'session:started', payload);
          emitToUser(menteeIdToNotify, 'mentorship:session:started', payload);
        } catch (emitErr: any) {
          logger.error('Socket emit failed (session:started):', emitErr);
        }
      }

      return {
        ...(updatedSession?.toJSON ? updatedSession.toJSON() : updatedSession),
        roomId: targetBooking._id?.toString(),
      };
    } catch (error: any) {
      logger.error(`Failed to start session: ${error.message}`);
      throw error;
    }
  }

  async completeSession(
    sessionId: string,
    userId: string,
    completionData: {
      actualDuration?: number;
      wasSuccessful?: boolean;
      followUpRequired?: boolean;
      followUpNotes?: string;
    },
    authToken?: string,
    bookingId?: string
  ): Promise<any> {
    try {
      const session = await this.getSessionById(sessionId, userId, authToken);

      const mentor = await Mentor.findOne({ userId, isDeleted: false });
      if (!mentor || session.mentorId !== mentor.mentorId) {
        throw new ForbiddenError('Only the mentor of this session can complete it');
      }

      let targetBooking: any = null;
      if (bookingId) {
        targetBooking = session.bookings?.find((b: any) => b._id?.toString() === bookingId);
        if (!targetBooking) throw new NotFoundError('Booking not found on this session');
      } else {
        const inProgress = (session.bookings || []).filter(
          (b: any) => b.status === BookingStatus.IN_PROGRESS
        );
        if (inProgress.length > 1) {
          throw new BadRequestError('Multiple in-progress bookings found — bookingId is required');
        }
        targetBooking = inProgress[0] || null;
      }

      if (!targetBooking || targetBooking.status !== BookingStatus.IN_PROGRESS) {
        throw new BadRequestError('Booking must be in progress before it can be completed');
      }

      const now = new Date();
      const actualDuration =
        completionData.actualDuration ??
        (targetBooking.startedAt
          ? Math.round((now.getTime() - new Date(targetBooking.startedAt).getTime()) / 60000)
          : session.duration);

      await SessionMentor.updateOne(
        { sessionId, 'bookings._id': targetBooking._id },
        {
          $set: {
            'bookings.$.status': BookingStatus.COMPLETED,
            'bookings.$.completion': {
              completedAt: now,
              actualDuration,
              wasSuccessful: completionData.wasSuccessful ?? true,
              followUpRequired: completionData.followUpRequired ?? false,
              followUpNotes: completionData.followUpNotes,
            },
          },
        }
      );

      let updatedSession = await SessionMentor.findOne({ sessionId });

      const allBookingsFinal = (updatedSession?.bookings || []).every((b: any) =>
        [BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.NO_SHOW].includes(b.status)
      );
      if (allBookingsFinal && updatedSession && updatedSession.status !== BookingStatus.COMPLETED) {
        updatedSession.status = BookingStatus.COMPLETED;
        updatedSession.endedAt = now;
        await updatedSession.save();
      }

      TrustScoreEvents.emit('SessionCompleted', {
        mentorId: session.mentorId,
        sessionId,
        bookingId: targetBooking._id,
        timestamp: now,
      });

      logger.info(`Booking completed: ${sessionId} / ${targetBooking._id}`);

      try {
        const endedPayload = {
          sessionId: session.sessionId,
          bookingId: targetBooking._id?.toString(),
          roomId: targetBooking._id?.toString(),
          endedAt: now.toISOString(),
          endedBy: userId,
          status: BookingStatus.COMPLETED,
          actualDuration,
        };
        const endedMenteeId = targetBooking.menteeId || targetBooking.bookedBy;
        emitToUser(userId, 'session:ended', endedPayload);
        if (endedMenteeId) emitToUser(endedMenteeId, 'session:ended', endedPayload);
      } catch (emitErr: any) {
        logger.error('Socket emit failed (session:ended):', emitErr);
      }

      const menteeIdToNotify = targetBooking.menteeId || targetBooking.bookedBy;
      if (menteeIdToNotify) {
        NotificationService.sendNotification({
          userId: menteeIdToNotify,
          type: NotificationType.SESSION_COMPLETED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'Session Completed',
            message: `Your session "${session.title}" is complete. Please leave a review!`,
          },
        }).catch((e) => logger.error('Notification failed (completeSession):', e));
      }

      return updatedSession;
    } catch (error: any) {
      logger.error(`Failed to complete session: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancel session
   */
  async cancelSession(
    sessionId: string,
    userId: string,
    reason: string,
    authToken: string | undefined,
    bookingId: string
  ): Promise<any> {
    try {
      if (!bookingId) {
        throw new BadRequestError('bookingId is required to cancel a session booking');
      }

      const session = await this.getSessionById(sessionId, userId, authToken);

      const booking = session.bookings?.find((b: any) => b._id?.toString() === bookingId);
      if (!booking) {
        throw new BadRequestError('Booking not found');
      }

      // ✅ FIX: was `session.scheduledAt` (the template's original time) —
      // inconsistent with startSession/rescheduleSession, which both key
      // off the SPECIFIC booking's own scheduledAt. If a booking had been
      // rescheduled, refund-eligibility here was being computed against the
      // stale template date instead of the mentee's actual new slot time.
      const bookingScheduledAt = booking.scheduledAt || session.scheduledAt;
      const hoursDiff = (bookingScheduledAt.getTime() - Date.now()) / (1000 * 60 * 60);
      const refundEligible = hoursDiff >= 24;

      const updateData: any = {
        $set: {
          'bookings.$.status': BookingStatus.CANCELLED,
          'cancellation': {
            cancelledBy: userId,
            cancelledAt: new Date(),
            reason,
            refundEligible
          }
        }
      };

      if (session.sessionType !== SessionType.GROUP_SESSION) {
        updateData.$set.status = BookingStatus.CANCELLED;
      }

      await SessionMentor.updateOne(
        { sessionId, 'bookings._id': bookingId },
        updateData
      );

      TrustScoreEvents.emit('SessionCancelled', {
        mentorId: session.mentorId,
        sessionId,
        timestamp: new Date()
      });

      logger.info(`Session cancelled: ${sessionId}`);

      try {
        const cancellingMenteeId = booking.menteeId || booking.bookedBy;
        const isCancelledByMentee = userId === cancellingMenteeId;

        let otherPartyUserId: string | null = null;
        if (isCancelledByMentee) {
          const mentorDoc = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });
          otherPartyUserId = mentorDoc?.userId || null;
        } else {
          otherPartyUserId = cancellingMenteeId || null;
        }

        if (otherPartyUserId) {
          NotificationService.sendNotification({
            userId: otherPartyUserId,
            type: NotificationType.SESSION_CANCELLED,
            channels: [NotificationChannel.IN_APP],
            data: {
              ...(isCancelledByMentee && cancellingMenteeId ? { menteeId: cancellingMenteeId } : {}),
              title: 'Session Cancelled',
              message: `Session "${session.title}" has been cancelled. Reason: ${reason}`,
            },
          }).catch((e) => logger.error('Notification failed (cancelSession):', e));
        }
      } catch (notifErr: any) {
        logger.warn(`⚠️ Failed to send cancellation notification: ${notifErr.message}`);
      }

      return session;
    } catch (error: any) {
      logger.error(`Failed to cancel session: ${error.message}`);
      throw error;
    }
  }

  async rescheduleSession(
    sessionId: string,
    userId: string,
    newScheduledAt: Date,
    reason: string | undefined,
    authToken: string | undefined,
    bookingId: string
  ): Promise<any> {
    try {
      if (!bookingId) {
        throw new BadRequestError('bookingId is required to reschedule a session booking');
      }

      const session = await this.getSessionById(sessionId, userId, authToken);
      const booking = session.bookings?.find((b: any) => b._id?.toString() === bookingId);
      if (!booking) {
        throw new BadRequestError('Booking not found');
      }

      const existingStartTime = booking.scheduledAt || session.scheduledAt;
      const hoursDiff = (existingStartTime.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursDiff < 24) {
        throw new BadRequestError('Cannot reschedule less than 24 hours before start time');
      }

      if (newScheduledAt <= new Date()) {
        throw new BadRequestError('New scheduled time must be in the future');
      }

      const updateData: any = {
        $set: {
          'bookings.$.status': BookingStatus.RESCHEDULED,
          'bookings.$.scheduledAt': newScheduledAt,
          'bookings.$.reminders.m15': false,
          'bookings.$.reminders.m5': false,
          'bookings.$.reminders.h24': false,
          'bookings.$.reminders.h1': false,
          'bookings.$.reminders.m30': false,
          'reschedule.lastRescheduledAt': new Date(),
          'reschedule.rescheduledBy': userId,
          'reschedule.reason': reason || 'Rescheduled by user'
        },
        $inc: { 'reschedule.count': 1 },
        $push: { 'reschedule.previousDates': session.scheduledAt }
      };

      if (session.sessionType !== SessionType.GROUP_SESSION) {
        updateData.$set.scheduledAt = newScheduledAt;
        updateData.$set.status = BookingStatus.RESCHEDULED;
      }

      await SessionMentor.updateOne(
        { sessionId, 'bookings._id': bookingId },
        updateData
      );
      logger.info(`Session rescheduled: ${sessionId}`);

      try {
        const menteeId = booking.menteeId || booking.bookedBy;
        const isRescheduledByMentee = userId === menteeId;

        let otherPartyUserId: string | null = null;
        if (isRescheduledByMentee) {
          const mentorDoc = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });
          otherPartyUserId = mentorDoc?.userId || null;
        } else {
          otherPartyUserId = menteeId || null;
        }

        if (otherPartyUserId) {
          NotificationService.sendNotification({
            userId: otherPartyUserId,
            type: NotificationType.SESSION_RESCHEDULED,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'Session Rescheduled',
              message: `Session "${session.title}" has been rescheduled to ${newScheduledAt}.`,
            },
          }).catch((e) => logger.error('Notification failed (rescheduleSession):', e));
        }
      } catch (notifErr: any) {
        logger.warn(`⚠️ Failed to send reschedule notification: ${notifErr.message}`);
      }

      // TODO: Update calendar via calendarSync.service

      return session;
    } catch (error: any) {
      logger.error(`Failed to reschedule session: ${error.message}`);
      throw error;
    }
  }

  async addReview(
    sessionId: string,
    userId: string,
    rating: number,
    review: string,
    authToken?: string
  ): Promise<any> {
    try {
      const session = await this.getSessionById(sessionId, userId, authToken);

      if (session.status !== BookingStatus.COMPLETED) {
        throw new BadRequestError('Can only review completed sessions');
      }

      const mentor       = await Mentor.findOne({ userId, isDeleted: false });
      const reviewerType = mentor && session.mentorId === mentor.mentorId ? 'mentor' : 'mentee';

      await session.addReview(rating, review, reviewerType);
      logger.info(`Review added to session: ${sessionId}`);

      try {
        let reviewedUserId: string | null = null;

        if (reviewerType === 'mentor') {
          const confirmedBooking = session.bookings?.find((b: any) =>
            b.status === BookingStatus.COMPLETED || b.status === BookingStatus.CONFIRMED
          );
          reviewedUserId = session.menteeId || confirmedBooking?.menteeId || confirmedBooking?.bookedBy || null;
        } else {
          const mentorDoc = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });
          reviewedUserId = mentorDoc?.userId || null;
        }

        if (reviewedUserId) {
          NotificationService.sendNotification({
            userId: reviewedUserId,
            type: NotificationType.REVIEW_RECEIVED,
            channels: [NotificationChannel.IN_APP],
            data: {
              ...(reviewerType === 'mentee' ? { menteeId: userId } : {}),
              title: 'New Review',
              message: `You received a new review with a rating of ${rating}★.`,
            },
          }).catch((e) => logger.error('Notification failed (addReview):', e));
        }
      } catch (notifErr: any) {
        logger.warn(`⚠️ Failed to send review notification: ${notifErr.message}`);
      }

      return session;
    } catch (error: any) {
      logger.error(`Failed to add review: ${error.message}`);
      throw error;
    }
  }

  async getSessionReceipt(
    sessionId: string,
    userId: string,
    bookingId?: string,
    authToken?: string
  ): Promise<any> {
    try {
      const session = await this.getSessionById(sessionId, userId, authToken);

      let targetBooking: any = null;
      if (bookingId) {
        targetBooking = session.bookings?.find((b: any) => b._id?.toString() === bookingId);
        if (!targetBooking) throw new NotFoundError('Booking not found on this session');
      } else {
        targetBooking = (session.bookings || []).find(
          (b: any) => b.status === BookingStatus.COMPLETED
        );
      }

      if (!targetBooking || targetBooking.status !== BookingStatus.COMPLETED) {
        throw new BadRequestError('Receipt is only available for completed bookings');
      }

      const menteeId = targetBooking.menteeId || targetBooking.bookedBy;
      const [menteeDoc, mentorDoc] = await Promise.all([
        menteeId ? User.findOne({ userId: menteeId }) : null,
        Mentor.findOne({ mentorId: session.mentorId, isDeleted: false }),
      ]);

      const menteeName =
        menteeDoc?.fullName ||
        `${menteeDoc?.firstName || ''} ${menteeDoc?.lastName || ''}`.trim() ||
        menteeDoc?.email ||
        'Student';

      const mentorUser = mentorDoc?.userId ? await User.findOne({ userId: mentorDoc.userId }) : null;
      const mentorName =
        mentorDoc?.title ||
        `${mentorUser?.firstName || ''} ${mentorUser?.lastName || ''}`.trim() ||
        'Mentor';

      return {
        bookingId: targetBooking._id?.toString(),
        sessionId: session.sessionId,
        title: session.title,
        menteeName,
        mentorName,
        scheduledAt: targetBooking.scheduledAt || session.scheduledAt,
        slotTime: targetBooking.slotTime || null,
        duration: session.duration,
        status: targetBooking.status,
        pricing: targetBooking.pricing || session.pricing,
        payment: targetBooking.payment || session.payment,
        completedAt: targetBooking.completion?.completedAt || null,
      };
    } catch (error: any) {
      logger.error(`Failed to build session receipt: ${error.message}`);
      throw error;
    }
  }

  async getSessionStats(
    userId: string,
    role: 'mentor' | 'mentee',
    _authToken?: string
  ): Promise<any> {
    try {
      const matchField = role === 'mentor' ? 'mentorId' : 'menteeId';

      const stats = await SessionMentor.aggregate([
        { $match: { [matchField]: userId } },
        {
          $group: {
            _id: null,
            total:     { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', BookingStatus.COMPLETED] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$status', BookingStatus.CANCELLED] }, 1, 0] } },
            upcoming:  {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gt: ['$scheduledAt', new Date()] },
                      { $in: ['$status', [BookingStatus.PENDING, BookingStatus.CONFIRMED]] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            totalRevenue: { $sum: '$pricing.basePrice' },
          },
        },
      ]);

      return stats[0] || {
        total: 0, completed: 0, cancelled: 0, upcoming: 0, totalRevenue: 0,
      };
    } catch (error: any) {
      logger.error(`Failed to fetch session stats: ${error.message}`);
      throw error;
    }
  }

  private mapSessionTypeToPrice(sessionType: SessionType): string {
    const mapping: Record<SessionType, string> = {
      [SessionType.QUICK_CALL]:      'quickCall',
      [SessionType.DEEP_DIVE]:       'deepDive',
      [SessionType.RESUME_REVIEW]:   'resumeReview',
      [SessionType.MOCK_INTERVIEW]:  'mockInterview',
      [SessionType.CAREER_PLANNING]: 'careerPlanning',
      [SessionType.PORTFOLIO_REVIEW]:'portfolioReview',
      [SessionType.ASK_QUERY]:       'askQuery',
      [SessionType.GROUP_SESSION]:   'groupSession',
    };
    return mapping[sessionType] as any;
  }
}

export default new MentorshipSessionService();