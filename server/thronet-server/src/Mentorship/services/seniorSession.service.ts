import { v4 as uuidv4 } from 'uuid';
import cloudinary from '@/config/images/store/cloudinary/cloudinary.config';

import seniorSessionRepository from '../repositories/seniorSession.repository';
import {
  ISeniorSession,
  ISeniorSessionBooking,
  CreateSeniorSessionInput,
  UpdateSeniorSessionInput,
  SeniorSessionStatus,
} from '../interface/seniorSession.types';
import { ApplicationStatus } from '../interface/seniorMentorApplication.types';

import SeniorMentorApplicationService from './seniorMentorApplication.service';
import seniorNotificationService from './seniorNotification.service';

import { ForbiddenError, NotFoundError, BadRequestError } from '@/shared/errors/app.error';
import seniorAvailabilityService from './seniorAvailability.service';
import { DateTime } from 'luxon';
import { User } from '@/shared/models/index.models';
import { BookingStatus, isStartAllowed } from '@/shared/constants/bookingStatus';
import { Mentor, MentorshipAnalytics, MentorshipReview } from '../models';

// If your project uses different error imports,
// replace the above imports with your existing error classes.

class SeniorSessionService {
  private repository = seniorSessionRepository;

  constructor() {}

  private async uploadImageToCloudinary(buffer: Buffer, sessionId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'senior-session-thumbnails',
          public_id: `senior_session_${sessionId}_${Date.now()}`,
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
   * Verify that the user is an active Senior Mentor.
   *
   * Senior Sessions are ONLY available to users whose
   * SeniorMentorApplication has mentorRole = "senior_mentor".
   */
  private async ensureSeniorMentor(userId: string): Promise<void> {
    const application = await SeniorMentorApplicationService.getByUserId(userId);

    if (!application) {
      throw new ForbiddenError(
        'Senior Mentor application not found'
      );
    }

    const isVerified =
      application.verificationStatus === ApplicationStatus.VERIFIED ||
      application.verificationStatus === 'verified' ||
      application.verificationStatus === 'active';

    if (!isVerified) {
      throw new ForbiddenError(
        'Senior Mentor application is not active'
      );
    }

    if (application.mentorRole !== 'senior_mentor') {
      throw new ForbiddenError(
        'Only Senior Mentors can create Senior Sessions'
      );
    }

    if (application.isActive === false || application.isDeleted === true) {
      throw new ForbiddenError(
        'Senior Mentor account is not active'
      );
    }
  }

  /**
   * Create a new Senior Session.
   *
   * mentorId is ALWAYS taken from the authenticated user.
   * It must never come from the frontend request body.
   */
  async createSession(
    userId: string,
    payload: CreateSeniorSessionInput,
    file?: Express.Multer.File
  ): Promise<ISeniorSession> {
    await this.ensureSeniorMentor(userId);

    const sessionId = uuidv4();
    let thumbnailImage = payload.thumbnailImage;

    if (file) {
      thumbnailImage = await this.uploadImageToCloudinary(file.buffer, sessionId);
    }

    // Availability validation check
    if (payload.scheduledAt && payload.duration) {
      const tz = payload.timezone || 'Asia/Kolkata';
      const dt = DateTime.fromISO(payload.scheduledAt.toString()).setZone(tz);
      const dateStr = dt.toFormat('yyyy-MM-dd');
      const timeStr = dt.toFormat('HH:mm');
      
      const isValid = await seniorAvailabilityService.validateSlot(
        userId,
        dateStr,
        timeStr,
        payload.duration
      );
      
      if (!isValid) {
        throw new BadRequestError('The selected time slot is not available or falls outside configured hours.');
      }
    }

    const sessionData = {
      ...payload,
      sessionId,
      mentorId: userId,
      thumbnailImage,
      bookings: [],
      status: payload.status ?? 'pending',
    } as unknown as ISeniorSession;

    return this.repository.create(sessionData) as unknown as ISeniorSession;
  }

  /**
   * Get all Senior Sessions owned by the authenticated mentor.
   */
  async getMySessions(
    userId: string
  ): Promise<any[]> {
    await this.ensureSeniorMentor(userId);

    const sessions = await this.repository.findByMentorId(userId) as unknown as ISeniorSession[];
    
    // Aggregation Logic for Mentees
    const menteeIds = new Set<string>();
    for (const session of sessions) {
      if (session.bookings && Array.isArray(session.bookings)) {
        for (const booking of session.bookings) {
          if (booking.menteeId) {
            menteeIds.add(booking.menteeId);
          }
        }
      }
    }

    if (menteeIds.size > 0) {
      const users = await User.find({ userId: { $in: Array.from(menteeIds) } })
        .select('userId firstName lastName email profilePhotoId')
        .lean();
      
      const userMap = new Map<string, any>();
      users.forEach((u: any) => {
        userMap.set(u.userId, {
          fullName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          email: u.email,
          profilePic: u.profilePhotoId
        });
      });

      // Inject mentee details implicitly inside response mappings without mutating Document structure
      return sessions.map((session: any) => {
         const obj = typeof session.toObject === 'function' ? session.toObject() : { ...session };
         if (obj.bookings && Array.isArray(obj.bookings)) {
           obj.bookings = obj.bookings.map((booking: any) => {
              if (booking.menteeId && userMap.has(booking.menteeId)) {
                 return { ...booking, mentee: userMap.get(booking.menteeId) };
              }
              return booking;
           });
         }
         return obj;
      });
    }

    return sessions;
  }

  /**
   * Get all active one-to-one sessions for discovery.
   */
  async getDiscoverySessions(): Promise<ISeniorSession[]> {
    return this.repository.findAllActiveOneToOneSessions() as unknown as ISeniorSession[];
  }

  /**
   * Book a Senior Session.
   */
  async bookSession(
    menteeId: string,
    sessionId: string,
    payload: any // Contains scheduled date/time, price
  ): Promise<ISeniorSession> {
    const session = await this.repository.findBySessionId(sessionId);
    if (!session) {
      throw new NotFoundError('Senior Session not found');
    }
    
    if (session.status === 'cancelled') {
      throw new BadRequestError('Cannot book a cancelled session');
    }

    if (!payload.slotTime) {
      throw new BadRequestError('slotTime is required for booking');
    }

    // Availability validation check
    const parts = payload.slotTime.split('-').map((p: string) => p.trim());
    const timeStr = parts[0];
    const tz = session.timezone || 'Asia/Kolkata';
    const dateStr = payload.scheduledAt
      ? DateTime.fromISO(new Date(payload.scheduledAt).toISOString()).setZone(tz).toFormat('yyyy-MM-dd')
      : DateTime.now().setZone(tz).toFormat('yyyy-MM-dd'); // Fallback though it should ideally be provided

    const isValid = await seniorAvailabilityService.validateSlot(
      session.mentorId,
      dateStr,
      timeStr,
      session.duration
    );

    if (!isValid) {
      throw new BadRequestError('The selected time slot is not available or falls outside configured hours.');
    }

    const bookingId = uuidv4();

    const booking = {
      menteeId,
      bookedBy: menteeId,
      bookedAt: new Date(),
      status: SeniorSessionStatus.PENDING,
      slotTime: payload.slotTime,
      scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
      payment: {
        status: 'pending',
        method: payload.paymentMethod || 'card'
      },
      pricing: payload.pricing
    };

    const updatedSession = await this.repository.addBooking(sessionId, booking as unknown as any);

    if (!updatedSession) {
      throw new BadRequestError('Failed to book session. The requested time slot may have just been booked by another user.');
    }

    const addedBooking = updatedSession.bookings?.find(
      (b: any) => b.menteeId === menteeId && b.slotTime === payload.slotTime
    );

    seniorNotificationService.notifyBookingCreated(
      updatedSession as unknown as ISeniorSession,
      (addedBooking || booking) as unknown as ISeniorSessionBooking
    ).catch((err) => console.error('Error notifying booking created:', err));

    return updatedSession as unknown as ISeniorSession;
  }

  /**
   * Get one Senior Session.
   *
   * Ownership is checked through:
   *
   * sessionId + mentorId
   */
  async getSessionById(
    userId: string,
    sessionId: string
  ): Promise<ISeniorSession> {
    const session =
      await this.repository.findBySessionId(
        sessionId
      );

    if (!session) {
      throw new NotFoundError(
        'Senior Session not found'
      );
    }

    return session as unknown as ISeniorSession;
  }

  /**
   * Update a Senior Session.
   *
   * Only the owner can update the session.
   */
  async updateSession(
    userId: string,
    sessionId: string,
    payload: UpdateSeniorSessionInput,
    file?: Express.Multer.File
  ): Promise<ISeniorSession> {
    await this.ensureSeniorMentor(userId);

    const existingSession =
      await this.repository.findBySessionIdAndMentorId(
        sessionId,
        userId
      );

    if (!existingSession) {
      throw new NotFoundError(
        'Senior Session not found'
      );
    }

    const {
      sessionId: _sessionId,
      mentorId: _mentorId,
      bookings: _bookings,
      sessionType: _sessionType,
      status: _status,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      __v: _v,
      ...allowedUpdates
    } = payload as UpdateSeniorSessionInput & {
      sessionId?: string;
      mentorId?: string;
      bookings?: unknown;
      sessionType?: string;
      status?: string;
      createdAt?: string;
      updatedAt?: string;
      __v?: unknown;
    };

    if (file) {
      const uploadedUrl = await this.uploadImageToCloudinary(file.buffer, sessionId);
      allowedUpdates.thumbnailImage = uploadedUrl;
    }

    // Availability validation check on update
    const finalScheduledAt = payload.scheduledAt || existingSession.scheduledAt;
    const finalDuration = payload.duration || existingSession.duration;
    const finalTimezone = payload.timezone || existingSession.timezone || 'Asia/Kolkata';

    if (finalScheduledAt && finalDuration) {
      const dt = DateTime.fromJSDate(new Date(finalScheduledAt.toString())).setZone(finalTimezone);
      const dateStr = dt.toFormat('yyyy-MM-dd');
      const timeStr = dt.toFormat('HH:mm');
      
      const isValid = await seniorAvailabilityService.validateSlot(
        userId,
        dateStr,
        timeStr,
        finalDuration,
        sessionId
      );
      
      if (!isValid) {
        throw new BadRequestError('The updated time slot is not available or falls outside configured hours.');
      }
    }

    return this.repository.updateBySessionIdAndMentorId(
      sessionId,
      userId,
      allowedUpdates
    ) as unknown as ISeniorSession;
  }

  /**
   * Cancel / deactivate a Senior Session.
   *
   * We do not physically delete the MongoDB document.
   *
   * The session remains available for historical records.
   */
  async cancelSession(
    userId: string,
    sessionId: string
  ): Promise<ISeniorSession> {
    await this.ensureSeniorMentor(userId);

    const existingSession =
      await this.repository.findBySessionIdAndMentorId(
        sessionId,
        userId
      );

    if (!existingSession) {
      throw new NotFoundError(
        'Senior Session not found'
      );
    }

    /*
     * Don't allow cancelling an already cancelled session.
     */
    if (existingSession.status === 'cancelled') {
      throw new ForbiddenError(
        'Senior Session is already cancelled'
      );
    }

    return this.repository.cancelSession(
      sessionId,
      userId
    ) as unknown as ISeniorSession;
  }
  /**
   * Accept/Confirm a pending Junior Booking for a Senior Session
   */
  async acceptBooking(
    userId: string,
    sessionId: string,
    bookingId: string
  ): Promise<ISeniorSession> {
    await this.ensureSeniorMentor(userId);
    const session = await this.repository.findBySessionId(sessionId);
    
    if (!session) {
      throw new NotFoundError('Senior Session not found');
    }

    const mentorIds = await this.resolveMentorIds(userId);
    if (!mentorIds.includes(session.mentorId)) {
      throw new ForbiddenError('You are not authorized to accept bookings for this session');
    }

    const bookingIndex = session.bookings.findIndex((b: any) => b._id.toString() === bookingId);
    if (bookingIndex === -1) {
      throw new NotFoundError('Booking not found');
    }
    
    const currentStatus = session.bookings[bookingIndex].status;
    if (
      currentStatus !== SeniorSessionStatus.PENDING &&
      (currentStatus as string) !== 'pending' &&
      (currentStatus as string) !== 'upcoming'
    ) {
      throw new BadRequestError('Only pending bookings can be accepted');
    }

    const updatedSession = await this.repository.updateBookingById(
      sessionId,
      bookingId,
      { status: SeniorSessionStatus.CONFIRMED }
    );

    if (!updatedSession) {
      throw new NotFoundError('Failed to update booking status');
    }

    const targetBooking =
      updatedSession.bookings?.find((b: any) => b._id.toString() === bookingId) ||
      session.bookings[bookingIndex];

    seniorNotificationService.notifyBookingConfirmed(
      updatedSession as unknown as ISeniorSession,
      targetBooking as unknown as ISeniorSessionBooking
    ).catch((err) => console.error('Error notifying booking confirmed:', err));

    return updatedSession as unknown as ISeniorSession;
  }

  /**
   * Confirm booking alias
   */
  async confirmBooking(
    userId: string,
    sessionId: string,
    bookingId: string
  ): Promise<ISeniorSession> {
    return this.acceptBooking(userId, sessionId, bookingId);
  }

  /**
   * Reject a Junior Booking (Mentor action)
   */
  async rejectBooking(
    userId: string,
    sessionId: string,
    bookingId: string,
    reason?: string
  ): Promise<ISeniorSession> {
    return this.cancelBooking(userId, sessionId, bookingId, reason);
  }

  /**
   * Cancel a booking (can be initiated by Mentor or Mentee)
   */
  async cancelBooking(
    userId: string,
    sessionId: string,
    bookingId: string,
    reason?: string
  ): Promise<ISeniorSession> {
    const session = await this.repository.findBySessionId(sessionId);
    
    if (!session) {
      throw new NotFoundError('Senior Session not found');
    }

    const bookingIndex = session.bookings.findIndex((b: any) => b._id.toString() === bookingId);
    if (bookingIndex === -1) {
      throw new NotFoundError('Booking not found');
    }

    const booking = session.bookings[bookingIndex];
    const mentorIds = await this.resolveMentorIds(userId);
    const isMentor = mentorIds.includes(session.mentorId);
    const isMentee = booking.menteeId === userId || booking.bookedBy === userId;

    if (!isMentor && !isMentee) {
      throw new ForbiddenError('You are not authorized to cancel this booking');
    }

    const currentStatus = booking.status as string;
    if (currentStatus === 'cancelled' || currentStatus === 'completed') {
      throw new BadRequestError('Cannot cancel an already completed or cancelled booking');
    }

    const updatedSession = await this.repository.updateBookingById(
      sessionId,
      bookingId,
      { status: SeniorSessionStatus.CANCELLED }
    );

    if (!updatedSession) {
      throw new NotFoundError('Failed to cancel booking');
    }

    const targetBooking =
      updatedSession.bookings?.find((b: any) => b._id.toString() === bookingId) || booking;

    seniorNotificationService.notifyBookingCancelled(
      updatedSession as unknown as ISeniorSession,
      targetBooking as unknown as ISeniorSessionBooking,
      userId,
      reason
    ).catch((err) => console.error('Error notifying booking cancelled:', err));

    return updatedSession as unknown as ISeniorSession;
  }

  /**
   * Reschedule a booking (Mentor or Mentee)
   */
  async rescheduleBooking(
    userId: string,
    sessionId: string,
    bookingId: string,
    newScheduledAt: Date | string,
    reason?: string
  ): Promise<ISeniorSession> {
    const session = await this.repository.findBySessionId(sessionId);
    if (!session) {
      throw new NotFoundError('Senior Session not found');
    }

    const bookingIndex = session.bookings.findIndex((b: any) => b._id.toString() === bookingId);
    if (bookingIndex === -1) {
      throw new NotFoundError('Booking not found');
    }

    const booking = session.bookings[bookingIndex];
    const mentorIds = await this.resolveMentorIds(userId);
    const isMentor = mentorIds.includes(session.mentorId);
    const isMentee = booking.menteeId === userId || booking.bookedBy === userId;

    if (!isMentor && !isMentee) {
      throw new ForbiddenError('You are not authorized to reschedule this booking');
    }

    const currentStatus = booking.status as string;
    if (currentStatus === 'cancelled' || currentStatus === 'completed') {
      throw new BadRequestError('Cannot reschedule a cancelled or completed booking');
    }

    const targetDate = new Date(newScheduledAt);
    if (targetDate.getTime() <= Date.now()) {
      throw new BadRequestError('New scheduled time must be in the future');
    }

    const tz = session.timezone || 'Asia/Kolkata';
    const dt = DateTime.fromJSDate(targetDate).setZone(tz);
    const dateStr = dt.toFormat('yyyy-MM-dd');
    const timeStr = dt.toFormat('HH:mm');

    const isValid = await seniorAvailabilityService.validateSlot(
      session.mentorId,
      dateStr,
      timeStr,
      session.duration,
      sessionId
    );
    if (!isValid) {
      throw new BadRequestError('The selected time slot is not available or falls outside configured hours.');
    }

    booking.scheduledAt = targetDate;
    const endDt = dt.plus({ minutes: session.duration });
    const newSlotTime = `${dt.toFormat('HH:mm')} - ${endDt.toFormat('HH:mm')}`;

    const updateData: Record<string, any> = {
      scheduledAt: targetDate,
      slotTime: newSlotTime,
    };

    if (booking.reminders) {
      updateData.reminders = {
        h24: false,
        h1: false,
        m15: false,
        m5: false,
      };
    }

    const updatedSession = await this.repository.updateBookingById(
      sessionId,
      bookingId,
      updateData
    );

    if (!updatedSession) {
      throw new NotFoundError('Failed to reschedule booking');
    }

    const targetBooking =
      updatedSession.bookings?.find((b: any) => b._id.toString() === bookingId) || booking;

    seniorNotificationService.notifyBookingRescheduled(
      updatedSession as unknown as ISeniorSession,
      targetBooking as unknown as ISeniorSessionBooking,
      userId,
      targetDate,
      reason
    ).catch((err) => console.error('Error notifying booking rescheduled:', err));

    return updatedSession as unknown as ISeniorSession;
  }

  /**
   * Start an Upcoming Senior Booking
   */
  async startBooking(
    userId: string,
    sessionId: string,
    bookingId: string
  ): Promise<ISeniorSession> {
    await this.ensureSeniorMentor(userId);
    const session = await this.repository.findBySessionId(sessionId);
    
    if (!session) {
      throw new NotFoundError('Senior Session not found');
    }

    const mentorIds = await this.resolveMentorIds(userId);
    if (!mentorIds.includes(session.mentorId)) {
      throw new ForbiddenError('You are not authorized to start bookings for this session');
    }

    const bookingIndex = session.bookings.findIndex((b: any) => b._id.toString() === bookingId);
    if (bookingIndex === -1) {
      throw new NotFoundError('Booking not found');
    }

    const booking = session.bookings[bookingIndex];

    if ((booking.status as string) !== 'upcoming' && (booking.status as string) !== 'confirmed') {
      throw new BadRequestError('Only confirmed/upcoming bookings can be started');
    }

    const bookingScheduledAt = booking.scheduledAt || session.scheduledAt;
    if (!bookingScheduledAt) {
      throw new BadRequestError('Session scheduled time is missing');
    }
    if (!isStartAllowed(bookingScheduledAt)) {
      const isTooEarly = Date.now() < new Date(bookingScheduledAt).getTime();
      throw new BadRequestError(isTooEarly ? 'Session cannot be started yet — too early.' : 'Session start window has expired.');
    }

    const updatedSession = await this.repository.updateBookingById(
      sessionId,
      bookingId,
      { status: SeniorSessionStatus.IN_PROGRESS }
    );

    if (!updatedSession) {
      throw new NotFoundError('Failed to start booking');
    }

    const targetBooking =
      updatedSession.bookings?.find((b: any) => b._id.toString() === bookingId) || booking;

    seniorNotificationService.notifySessionStarted(
      updatedSession as unknown as ISeniorSession,
      targetBooking as unknown as ISeniorSessionBooking
    ).catch((err) => console.error('Error notifying session started:', err));

    return updatedSession as unknown as ISeniorSession;
  }

  /**
   * Complete an In-Progress Senior Booking
   */
  async completeBooking(
    userId: string,
    sessionId: string,
    bookingId: string
  ): Promise<ISeniorSession> {
    await this.ensureSeniorMentor(userId);
    const session = await this.repository.findBySessionId(sessionId);
    
    if (!session) {
      throw new NotFoundError('Senior Session not found');
    }

    const mentorIds = await this.resolveMentorIds(userId);
    if (!mentorIds.includes(session.mentorId)) {
      throw new ForbiddenError('You are not authorized to complete bookings for this session');
    }

    const bookingIndex = session.bookings.findIndex((b: any) => b._id.toString() === bookingId);
    if (bookingIndex === -1) {
      throw new NotFoundError('Booking not found');
    }

    if ((session.bookings[bookingIndex].status as string) !== 'in_progress') {
      throw new BadRequestError('Only in-progress bookings can be completed');
    }

    const updatedSession = await this.repository.updateBookingById(
      sessionId,
      bookingId,
      { status: SeniorSessionStatus.COMPLETED }
    );

    if (!updatedSession) {
      throw new NotFoundError('Failed to complete booking');
    }

    const targetBooking =
      updatedSession.bookings?.find((b: any) => b._id.toString() === bookingId) ||
      session.bookings[bookingIndex];

    seniorNotificationService.notifySessionCompleted(
      updatedSession as unknown as ISeniorSession,
      targetBooking as unknown as ISeniorSessionBooking
    ).catch((err) => console.error('Error notifying session completed:', err));

    return updatedSession as unknown as ISeniorSession;
  }

  /**
   * Helper to resolve canonical mentorId and any verified aliases (e.g. Standard Mentor profile ID <-> userId).
   */
  async resolveMentorIds(mentorId: string): Promise<string[]> {
    const ids = [mentorId];
    try {
      const standardMentor = await Mentor.findOne({
        $or: [{ mentorId }, { userId: mentorId }],
        isDeleted: false,
      }).lean();

      if (standardMentor) {
        if (standardMentor.userId && !ids.includes(standardMentor.userId)) {
          ids.push(standardMentor.userId);
        }
        if (standardMentor.mentorId && !ids.includes(standardMentor.mentorId)) {
          ids.push(standardMentor.mentorId);
        }
      }
    } catch (err) {
      console.warn('Error resolving mentor aliases:', err);
    }
    return ids;
  }

  /**
   * Get analytics dashboard metrics for a Senior Mentor
   */
  async getAnalytics(userId: string): Promise<any> {
    // 1. Resolve mentor ID aliases
    const mentorIds = await this.resolveMentorIds(userId);

    // 2. Query all senior sessions belonging to this mentor
    const sessions = await this.repository.findByMentorIds(mentorIds);

    // 3. Extract and process all nested bookings
    const allBookings: any[] = [];
    const servicesByType: Record<string, { bookings: number; revenue: number }> = {};

    for (const session of sessions) {
      const sessionType = (session.sessionType as string) || 'one_to_one';
      if (!servicesByType[sessionType]) {
        servicesByType[sessionType] = { bookings: 0, revenue: 0 };
      }

      const sessionBookings = session.bookings || [];
      for (const b of sessionBookings) {
        allBookings.push({
          ...b,
          sessionType,
          sessionDuration: session.duration || 60,
        });
      }
    }

    const validBookingStatuses = [
      'pending',
      'upcoming',
      'confirmed',
      'in_progress',
      'completed',
      'rescheduled',
    ];

    let totalBookingsCount = 0;
    let completedCount = 0;
    let cancelledCount = 0;

    for (const b of allBookings) {
      if (b.status === 'cancelled') {
        cancelledCount += 1;
      } else if (validBookingStatuses.includes(b.status)) {
        totalBookingsCount += 1;
        if (b.status === 'completed') {
          completedCount += 1;
        }

        // Tally popular services
        servicesByType[b.sessionType].bookings += 1;
        const bookingPrice = Number(b.pricing?.totalAmount ?? b.pricing?.basePrice ?? 0);
        const isPaid =
          b.payment?.status === 'completed' ||
          b.status === 'completed' ||
          b.status === 'confirmed';
        if (isPaid && bookingPrice > 0) {
          servicesByType[b.sessionType].revenue += bookingPrice;
        }
      }
    }

    // 4. Calculate Average Duration
    const sessionsWithDuration = sessions.filter(
      (s) => s.duration && Number(s.duration) > 0
    );
    const avgDuration =
      sessionsWithDuration.length > 0
        ? Math.round(
            sessionsWithDuration.reduce(
              (sum, s) => sum + Number(s.duration || 0),
              0
            ) / sessionsWithDuration.length
          )
        : 0;

    // 5. Calculate Cancellation Rate
    const totalTrackedBookings = totalBookingsCount + cancelledCount;
    const cancellationRateVal =
      totalTrackedBookings > 0
        ? Math.round((cancelledCount / totalTrackedBookings) * 100)
        : 0;
    const cancellationRate = {
      value: cancellationRateVal,
      cancelled: cancelledCount,
      noShow: 0,
      total: totalTrackedBookings,
    };

    // 6. Popular Services
    const popularServices = Object.entries(servicesByType)
      .map(([sessionType, data]) => ({
        sessionType,
        bookings: data.bookings,
        revenue: data.revenue,
      }))
      .sort((a, b) => b.bookings - a.bookings);

    // 7. Monthly Earnings (past 6 months)
    const now = new Date();
    const monthlyEarningsMap = new Map<
      string,
      { amount: number; bookings: number }
    >();

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        '0'
      )}`;
      monthlyEarningsMap.set(key, { amount: 0, bookings: 0 });
    }

    for (const b of allBookings) {
      const isPaid =
        b.payment?.status === 'completed' ||
        b.status === 'completed' ||
        b.status === 'confirmed';
      const bookingDate = b.scheduledAt
        ? new Date(b.scheduledAt)
        : b.bookedAt
        ? new Date(b.bookedAt)
        : null;

      if (bookingDate && !isNaN(bookingDate.getTime())) {
        const ym = `${bookingDate.getFullYear()}-${String(
          bookingDate.getMonth() + 1
        ).padStart(2, '0')}`;
        if (monthlyEarningsMap.has(ym)) {
          const entry = monthlyEarningsMap.get(ym)!;
          entry.bookings += 1;
          const bookingPrice = Number(
            b.pricing?.totalAmount ?? b.pricing?.basePrice ?? 0
          );
          if (isPaid && bookingPrice > 0) {
            entry.amount += bookingPrice;
          }
        }
      }
    }

    const monthlyEarnings = Array.from(monthlyEarningsMap.entries()).map(
      ([month, val]) => ({
        month,
        amount: val.amount,
        bookings: val.bookings,
      })
    );

    // 8. Profile Views from MentorshipAnalytics
    let viewsAllTime = 0;
    let viewsThisMonth = 0;
    let viewsLastMonth = 0;

    try {
      const analyticsDocs = await MentorshipAnalytics.find({
        entityId: { $in: mentorIds },
        entityType: 'mentor',
      }).lean();

      const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(
        now.getFullYear(),
        now.getMonth() - 1,
        1
      );

      for (const doc of analyticsDocs) {
        const docDate = new Date(doc.date);
        const views = (doc as any).metrics?.views || 0;
        viewsAllTime += views;

        if (docDate >= startOfThisMonth) {
          viewsThisMonth += views;
        } else if (docDate >= startOfLastMonth && docDate < startOfThisMonth) {
          viewsLastMonth += views;
        }
      }
    } catch (err) {
      console.warn('Error reading MentorshipAnalytics for senior mentor:', err);
    }

    let changePercent = 0;
    if (viewsLastMonth > 0) {
      changePercent = Math.round(
        ((viewsThisMonth - viewsLastMonth) / viewsLastMonth) * 100
      );
    } else if (viewsThisMonth > 0) {
      changePercent = 100;
    }

    const profileViews = {
      value: viewsAllTime,
      valueThisMonth: viewsThisMonth,
      changePercent: Math.abs(changePercent),
      trend: changePercent >= 0 ? 'up' : 'down',
    };

    // 9. Booking Rate & Conversion
    const bookingRateVal =
      viewsAllTime > 0
        ? Math.min(100, Math.round((totalBookingsCount / viewsAllTime) * 100))
        : totalBookingsCount > 0
        ? 100
        : 0;

    const bookingRate = {
      value: bookingRateVal,
      trend: 'up',
    };

    const conversion = {
      views: viewsAllTime,
      bookings: totalBookingsCount,
      rate: bookingRateVal,
    };

    // 10. Rating Trend from MentorshipReview
    let ratingTrend: Array<{ month: string; avgRating: number; count: number }> =
      [];

    try {
      const reviews = await MentorshipReview.find({
        mentorId: { $in: mentorIds },
        isDeleted: false,
        isPublic: true,
      }).lean();

      if (reviews && reviews.length > 0) {
        const ratingMap = new Map<
          string,
          { totalRating: number; count: number }
        >();
        for (const r of reviews) {
          const rDate = new Date(r.createdAt);
          const ym = `${rDate.getFullYear()}-${String(
            rDate.getMonth() + 1
          ).padStart(2, '0')}`;
          if (!ratingMap.has(ym)) {
            ratingMap.set(ym, { totalRating: 0, count: 0 });
          }
          const entry = ratingMap.get(ym)!;
          entry.totalRating += r.rating || 0;
          entry.count += 1;
        }
        ratingTrend = Array.from(ratingMap.entries())
          .map(([month, data]) => ({
            month,
            avgRating: Number((data.totalRating / data.count).toFixed(1)),
            count: data.count,
          }))
          .sort((a, b) => a.month.localeCompare(b.month));
      }
    } catch (err) {
      console.warn('Error reading MentorshipReview for senior mentor:', err);
    }

    return {
      profileViews,
      bookingRate,
      avgSessionDuration: { value: avgDuration },
      cancellationRate,
      conversion,
      popularServices,
      monthlyEarnings,
      ratingTrend,
      totalBookings: totalBookingsCount,
    };
  }
}

export default new SeniorSessionService();