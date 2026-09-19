import SeniorSession, {
  SeniorSessionDocument,
} from '../models/SeniorSession';

import {
  ISeniorSession,
  ISeniorSessionBooking,
} from '../interface/seniorSession.types';

class SeniorSessionRepository {
  /**
   * Create a new senior session
   */
  async create(
    data: ISeniorSession
  ): Promise<SeniorSessionDocument> {
    const session = new SeniorSession(data);

    return await session.save();
  }

  /**
   * Find a session by its public sessionId
   */
  async findBySessionId(
    sessionId: string
  ): Promise<SeniorSessionDocument | null> {
    return await SeniorSession.findOne({
      sessionId,
    }).lean();
  }

  /**
   * Find all sessions belonging to a senior mentor
   */
  async findByMentorId(
    mentorId: string,
    includeInactive = false
  ): Promise<SeniorSessionDocument[]> {
    const filter: Record<string, unknown> = {
      mentorId,
    };

    if (!includeInactive) {
      filter.status = {
        $ne: 'cancelled',
      };
    }

    return await SeniorSession.find(filter)
      .sort({ scheduledAt: 1 })
      .lean();
  }

  /**
   * Find a session owned by a specific mentor.
   *
   * This is useful for ownership checks in the service layer.
   */
  async findBySessionIdAndMentorId(
    sessionId: string,
    mentorId: string
  ): Promise<SeniorSessionDocument | null> {
    return await SeniorSession.findOne({
      sessionId,
      mentorId,
    }).lean();
  }

  /**
   * Update session information
   */
  async updateBySessionId(
    sessionId: string,
    data: Partial<ISeniorSession>
  ): Promise<SeniorSessionDocument | null> {
    return await SeniorSession.findOneAndUpdate(
      { sessionId },
      {
        $set: data,
      },
      {
        new: true,
        runValidators: true,
      }
    ).lean();
  }

  /**
   * Update a session belonging to a specific mentor.
   *
   * Ownership is intentionally represented in the query,
   * while the actual authorization decision remains in the service.
   */
  async updateBySessionIdAndMentorId(
    sessionId: string,
    mentorId: string,
    data: Partial<ISeniorSession>
  ): Promise<SeniorSessionDocument | null> {
    return await SeniorSession.findOneAndUpdate(
      {
        sessionId,
        mentorId,
      },
      {
        $set: data,
      },
      {
        new: true,
        runValidators: true,
      }
    ).lean();
  }

  /**
   * Add a junior booking to a senior session
   */
  async addBooking(
    sessionId: string,
    booking: ISeniorSessionBooking
  ): Promise<SeniorSessionDocument | null> {
    return await SeniorSession.findOneAndUpdate(
      {
        sessionId,
      },
      {
        $push: {
          bookings: booking,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).lean();
  }

  /**
   * Add a booking while also enforcing mentor ownership
   */
  async addBookingByMentor(
    sessionId: string,
    mentorId: string,
    booking: ISeniorSessionBooking
  ): Promise<SeniorSessionDocument | null> {
    return await SeniorSession.findOneAndUpdate(
      {
        sessionId,
        mentorId,
      },
      {
        $push: {
          bookings: booking,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).lean();
  }

  /**
   * Find a particular junior's booking
   */
  async findBooking(
    sessionId: string,
    menteeId: string
  ): Promise<ISeniorSessionBooking | null> {
    const session = await SeniorSession.findOne(
      {
        sessionId,
        'bookings.menteeId': menteeId,
      },
      {
        bookings: {
          $elemMatch: {
            menteeId,
          },
        },
      }
    ).lean();

    return session?.bookings?.[0] ?? null;
  }

  /**
   * Update a particular junior's booking
   */
  async updateBooking(
    sessionId: string,
    menteeId: string,
    data: Partial<ISeniorSessionBooking>
  ): Promise<SeniorSessionDocument | null> {
    const updateFields: Record<string, unknown> = {};

    Object.entries(data).forEach(([key, value]) => {
      updateFields[`bookings.$.${key}`] = value;
    });

    return await SeniorSession.findOneAndUpdate(
      {
        sessionId,
        'bookings.menteeId': menteeId,
      },
      {
        $set: updateFields,
      },
      {
        new: true,
        runValidators: true,
      }
    ).lean();
  }

  /**
   * Remove a junior booking
   *
   * Use this only if the business layer decides that
   * physical removal is appropriate.
   */
  async removeBooking(
    sessionId: string,
    menteeId: string
  ): Promise<SeniorSessionDocument | null> {
    return await SeniorSession.findOneAndUpdate(
      {
        sessionId,
        'bookings.menteeId': menteeId,
      },
      {
        $pull: {
          bookings: {
            menteeId,
          },
        },
      },
      {
        new: true,
      }
    ).lean();
  }

  /**
   * Cancel a session by updating its status.
   *
   * This does NOT delete the MongoDB document.
   */
  async cancelSession(
    sessionId: string,
    mentorId: string
  ): Promise<SeniorSessionDocument | null> {
    return await SeniorSession.findOneAndUpdate(
      {
        sessionId,
        mentorId,
      },
      {
        $set: {
          status: 'cancelled',
        },
      },
      {
        new: true,
        runValidators: true,
      }
    ).lean();
  }

  /**
   * Count registered juniors
   */
  async countBookings(
    sessionId: string
  ): Promise<number> {
    const session = await SeniorSession.findOne(
      { sessionId },
      { bookings: 1 }
    ).lean();

    return session?.bookings?.length ?? 0;
  }
}

export default new SeniorSessionRepository();