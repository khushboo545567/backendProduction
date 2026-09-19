import { v4 as uuidv4 } from 'uuid';

import seniorSessionRepository from '../repositories/seniorSession.repository';
import { ISeniorSession, CreateSeniorSessionInput, UpdateSeniorSessionInput } from '../interface/seniorSession.types';

import SeniorMentorApplicationService from './seniorMentorApplication.service';

import { ForbiddenError, NotFoundError } from '@/shared/errors/app.error';

// If your project uses different error imports,
// replace the above imports with your existing error classes.

class SeniorSessionService {
  private repository = seniorSessionRepository;

  constructor() {}

  /**
   * Verify that the user is an active Senior Mentor.
   *
   * Senior Sessions are ONLY available to users whose
   * SeniorMentorApplication has mentorRole = "senior_mentor".
   */
  private async ensureSeniorMentor(userId: string): Promise<void> {
    const application =
      await SeniorMentorApplicationService.getByUserId(userId);

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
    payload: CreateSeniorSessionInput
  ): Promise<ISeniorSession> {
    await this.ensureSeniorMentor(userId);

    const sessionData = {
      ...payload,
      sessionId: uuidv4(),
      mentorId: userId,
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
    await this.ensureSeniorMentor(userId);

    const session =
      await this.repository.findBySessionIdAndMentorId(
        sessionId,
        userId
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
    payload: UpdateSeniorSessionInput
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
     * Never allow these fields to be changed through
     * the update payload.
     */
    const {
      sessionId: _sessionId,
      mentorId: _mentorId,
      bookings: _bookings,
      ...allowedUpdates
    } = payload as UpdateSeniorSessionInput & {
      sessionId?: string;
      mentorId?: string;
      bookings?: unknown;
    };

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