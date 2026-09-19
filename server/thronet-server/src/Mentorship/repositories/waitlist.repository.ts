import Waitlist, { WaitlistStatus } from '../models/Waitlist';

class WaitlistRepository {
  /**
   * Returns a real Mongoose document (NOT lean) — required for
   * entry.cancel(), entry.notify(), entry.markAsBooked().
   */
  async findByWaitlistId(waitlistId: string): Promise<any | null> {
    return await Waitlist.findOne({ waitlistId });
  }

  async findById(objectId: string): Promise<any | null> {
    return await Waitlist.findById(objectId).lean();
  }

  async findByIdForUpdate(objectId: string): Promise<any | null> {
    return await Waitlist.findById(objectId);
  }

  async create(data: any): Promise<any> {
    const entry = new Waitlist(data);
    await entry.save();
    return entry.toObject();
  }

  /** No status given => all statuses (mentor dashboard filters by tab). */
  async findByMentorId(mentorId: string, status?: WaitlistStatus): Promise<any[]> {
    const query: any = { mentorId };
    if (status) query.status = status;
    return await Waitlist.find(query).sort({ priority: -1, position: 1 }).lean();
  }

  /** All statuses so "My Waitlist" can show Waiting / Approved / Removed. */
  async findByUserId(userId: string): Promise<any[]> {
    return await Waitlist.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
  }

  async countActive(mentorId: string): Promise<number> {
    return await Waitlist.countDocuments({ mentorId, status: WaitlistStatus.ACTIVE });
  }

  async updateByWaitlistId(waitlistId: string, updates: any): Promise<any | null> {
    return await Waitlist.findOneAndUpdate(
      { waitlistId },
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();
  }

  async getStats(mentorId: string): Promise<any> {
    const [byStatus, total, active] = await Promise.all([
      Waitlist.aggregate([
        { $match: { mentorId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Waitlist.countDocuments({ mentorId }),
      Waitlist.countDocuments({ mentorId, status: WaitlistStatus.ACTIVE }),
    ]);
    return { total, active, byStatus };
  }
}

export default new WaitlistRepository();