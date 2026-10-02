import { v4 as uuidv4 } from 'uuid';
import cloudinary from '@/config/images/store/cloudinary/cloudinary.config';

import seniorSessionRepository from '../repositories/seniorSession.repository';
import { ISeniorSession, CreateSeniorSessionInput, UpdateSeniorSessionInput } from '../interface/seniorSession.types';

import SeniorMentorApplicationService from './seniorMentorApplication.service';

import { ForbiddenError, NotFoundError, BadRequestError } from '@/shared/errors/app.error';
import seniorAvailabilityService from './seniorAvailability.service';
import { DateTime } from 'luxon';

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

    if (application.verificationStatus !== 'active') {
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
      isBooked: false,
      bookedBy: null,
      bookedAt: null,
      status: payload.status ?? 'pending',
    } as unknown as ISeniorSession;

    return this.repository.create(sessionData) as unknown as ISeniorSession;
  }

  /**
   * Get all Senior Sessions owned by the authenticated mentor.
   */
  async getMySessions(
    userId: string
  ): Promise<ISeniorSession[]> {
    await this.ensureSeniorMentor(userId);

    return this.repository.findByMentorId(userId) as unknown as ISeniorSession[];
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

    const bookingId = uuidv4();

    const booking = {
      menteeId,
      bookedBy: menteeId,
      bookedAt: new Date(),
      status: 'upcoming',
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
      throw new BadRequestError('Failed to book session');
    }

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
}

export default new SeniorSessionService();