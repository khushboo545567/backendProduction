import { Mentor } from '../models';

class MentorRepository {

  async findByMentorId(mentorId: string): Promise<any | null> {
    return await Mentor.findOne({ mentorId, isDeleted: false }).lean();
  }

  async findById(objectId: string): Promise<any | null> {
    return await Mentor.findById(objectId).lean();
  }

  async findByUserId(userId: string): Promise<any | null> {
    return await Mentor.findOne({ userId, isDeleted: false }).lean();
  }

  async create(data: any): Promise<any> {
    const mentor = new Mentor(data);
    await mentor.save();
    return mentor.toObject();
  }

  async updateByMentorId(mentorId: string, updates: any): Promise<any | null> {
    const mongoUpdate: any = {};
    if (updates.$unset) {
      mongoUpdate.$unset = updates.$unset;
      delete updates.$unset;
    }
    if (Object.keys(updates).length > 0) {
      mongoUpdate.$set = updates;
    }
    const mentor = await Mentor.findOneAndUpdate(
      { mentorId, isDeleted: false },
      mongoUpdate,
      { new: true, runValidators: true }   // ✅ FIX: schema validation ab update ke time bhi chalegi
    );
    if (!mentor) return null;
    return mentor.toObject();
  }


    // Profile photo hatane ke liye $unset
    async removeProfilePicByMentorId(mentorId: string): Promise<any | null> {
      const mentor = await Mentor.findOneAndUpdate(
        { mentorId, isDeleted: false },
        { $unset: { profilePic: 1 } },
        { new: true }
      );
      if (!mentor) return null;
      return mentor.toObject();
    }
  
    async softDeleteByMentorId(mentorId: string): Promise<boolean> {

    const mentor = await Mentor.findOne({ mentorId, isDeleted: false });
    if (!mentor) return false;

    mentor.isDeleted = true;
    mentor.deletedAt = new Date();
    await mentor.save();
    return true;
  }

  async findAll(
    query: any,
    sortQuery: any,
    skip: number,
    limit: number
  ): Promise<any[]> {
    return await Mentor.find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limit)
      .lean();
  }

  async count(query: any): Promise<number> {
    return await Mentor.countDocuments(query);
  }

  async getStatsByMentorId(mentorId: string): Promise<any | null> {
    const mentor = await Mentor.findOne({ mentorId, isDeleted: false })
      .select('stats')
      .lean();
    return mentor?.stats || null;
  }

  async findByMentorIds(mentorIds: string[]): Promise<any[]> {
    return await Mentor.find({
      mentorId: { $in: mentorIds },
      isDeleted: false,
    }).lean();
  }

  async aggregateDomains(pipeline: any[]): Promise<any[]> {
    return await Mentor.aggregate(pipeline).exec();
  }

  async aggregateCompanies(pipeline: any[]): Promise<any[]> {
    return await Mentor.aggregate(pipeline).exec();
  }

  async findForSuggestions(keyword: string, limit: number): Promise<any[]> {
    return await Mentor.find({
      status: 'active',
      isDeleted: false,
      $or: [
        { skills: { $regex: keyword, $options: 'i' } },
        { domains: { $regex: keyword, $options: 'i' } },
        { title: { $regex: keyword, $options: 'i' } },
        { 'experience.currentRole': { $regex: keyword, $options: 'i' } },
      ],
    })
      .select('skills domains title experience.currentRole')
      .limit(limit)
      .lean();
  }

  // ⭐ NEW: toggle a userId in savedBy atomically ($addToSet / $pull avoid
  // read-then-save race conditions that a full-document .save() would have).
  // Returns null if mentor not found, otherwise the new saved state.
  async toggleSavedBy(mentorId: string, userId: string): Promise<{ saved: boolean } | null> {
    const existing = await Mentor.findOne({ mentorId, isDeleted: false }).select('savedBy').lean();
    if (!existing) return null;

    const wasSaved = ((existing as any).savedBy || []).includes(userId);

    if (wasSaved) {
      await Mentor.updateOne({ mentorId, isDeleted: false }, { $pull: { savedBy: userId } });
    } else {
      await Mentor.updateOne({ mentorId, isDeleted: false }, { $addToSet: { savedBy: userId } });
    }

    return { saved: !wasSaved };
  }

  // ⭐ NEW: push a report onto a mentor's reports array
  async addReport(
    mentorId: string,
    report: { reportedBy: string; reason: string; status: string; createdAt: Date }
  ): Promise<any | null> {
    const mentor = await Mentor.findOneAndUpdate(
      { mentorId, isDeleted: false },
      { $push: { reports: report } },
      { new: true }
    ).lean();
    return mentor;
  }
}

export default new MentorRepository();