import mongoose from 'mongoose';
import CommunityEvent, { ICommunityEvent } from '@/Mentorship/models/CommunityEvent';
import EventRSVP from '@/Mentorship/models/EventRSVP';
import { CreateCommunityEventDTO, UpdateCommunityEventDTO, CommunityEventListQuery } from '@/Mentorship/interface/communityEvent.types';

// CommunityEvent.createdBy aur EventRSVP.user ab plain UUID string hain
// (ObjectId ref nahi), isliye Mongoose ka .populate() use nahi ho sakta.
// Ye helper manually User collection se un UUIDs ka profile fetch karke
// docs ke saath attach karta hai — jaisa top-mentors / forum.repository
// mein kiya tha.
async function attachUserField<T extends Record<string, any>>(
  docs: T[],
  field: string,
  projection = 'userId firstName lastName'   // ← default bhi update karo
): Promise<any[]> {
  if (docs.length === 0) return docs;

  const ids = [...new Set(docs.map((d) => d[field]).filter(Boolean))];
  if (ids.length === 0) return docs.map((d) => ({ ...toPlain(d), [field]: null }));

  const User = mongoose.model('User');
  const users = await User.find({ userId: { $in: ids } }, projection).lean();
  const userMap = new Map(
    users.map((u: any) => [
      u.userId,
      { userId: u.userId, name: `${u.firstName} ${u.lastName || ''}`.trim() },
    ])
  );

  return docs.map((d) => ({
    ...toPlain(d),
    [field]: userMap.get(d[field]) || null,
  }));
}

function toPlain(doc: any) {
  return typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

export class CommunityEventRepository {
  async create(createdBy: string, data: CreateCommunityEventDTO): Promise<ICommunityEvent> {
    return CommunityEvent.create({
      title: data.title,
      description: data.description,
      date: new Date(data.date),
      type: data.type,
      resourceLink: data.resourceLink,
      capacity: data.capacity,
      createdBy,
    });
  }

  async findById(id: string) {
    const event = await CommunityEvent.findById(id);
    if (!event) return null;
    const [withCreator] = await attachUserField([event], 'createdBy', 'userId name avatar');
    return withCreator;
  }

  async update(id: string, data: UpdateCommunityEventDTO): Promise<ICommunityEvent | null> {
    const updates: Record<string, any> = { ...data };
    if (data.date) updates.date = new Date(data.date);
    return CommunityEvent.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
  }

  async cancel(id: string): Promise<ICommunityEvent | null> {
    return CommunityEvent.findByIdAndUpdate(id, { isCancelled: true }, { new: true });
  }

  async delete(id: string) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await EventRSVP.deleteMany({ event: id }).session(session);
      const deleted = await CommunityEvent.findByIdAndDelete(id).session(session);
      await session.commitTransaction();
      return deleted;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async list(query: CommunityEventListQuery) {
    const { type, upcoming, page = 1, limit = 20 } = query;
    const filter: Record<string, any> = { isCancelled: false };
    if (type) filter.type = type;
    if (upcoming) filter.date = { $gte: new Date() };

    const [rawItems, total] = await Promise.all([
      CommunityEvent.find(filter)
        .sort({ date: upcoming ? 1 : -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      CommunityEvent.countDocuments(filter),
    ]);

    const items = await attachUserField(rawItems, 'createdBy', 'userId name avatar');

    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Atomic RSVP: uses upsert on the unique (event,user) index so two
   * concurrent requests from the same user can't create duplicate rows,
   * and increments participantsCount only on a real state transition.
   */
  async rsvp(eventId: string, userId: string): Promise<{ event: ICommunityEvent; alreadyGoing: boolean }> {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const existing = await EventRSVP.findOne({ event: eventId, user: userId }).session(session);

      if (existing && existing.status === 'going') {
        await session.commitTransaction();
        const event = await CommunityEvent.findById(eventId);
        if (!event) throw new Error('EVENT_NOT_FOUND');
        return { event, alreadyGoing: true };
      }

      if (existing && existing.status === 'cancelled') {
        existing.status = 'going';
        await existing.save({ session });
      } else {
        await EventRSVP.create([{ event: eventId, user: userId, status: 'going' }], { session });
      }

      const event = await CommunityEvent.findByIdAndUpdate(
        eventId,
        { $inc: { participantsCount: 1 } },
        { new: true, session }
      );

      if (!event) throw new Error('EVENT_NOT_FOUND');

      await session.commitTransaction();
      return { event, alreadyGoing: false };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async cancelRsvp(eventId: string, userId: string): Promise<ICommunityEvent | null> {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const existing = await EventRSVP.findOne({
        event: eventId,
        user: userId,
        status: 'going',
      }).session(session);

      if (!existing) {
        await session.commitTransaction();
        return CommunityEvent.findById(eventId);
      }

      existing.status = 'cancelled';
      await existing.save({ session });

      const event = await CommunityEvent.findByIdAndUpdate(
        eventId,
        { $inc: { participantsCount: -1 } },
        { new: true, session }
      );

      await session.commitTransaction();
      return event;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async isUserGoing(eventId: string, userId: string): Promise<boolean> {
    const rsvp = await EventRSVP.findOne({ event: eventId, user: userId, status: 'going' });
    return !!rsvp;
  }

  async listAttendees(eventId: string, page = 1, limit = 30) {
    const [rawItems, total] = await Promise.all([
      EventRSVP.find({ event: eventId, status: 'going' })
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      EventRSVP.countDocuments({ event: eventId, status: 'going' }),
    ]);
    const items = await attachUserField(rawItems, 'user', 'userId name avatar headline');
    return { items, total, page, pages: Math.ceil(total / limit) };
  }
}

export default new CommunityEventRepository();