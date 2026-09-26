import mongoose from 'mongoose';
import Mentor from '@/Mentorship/models/Mentor';
import { logger } from '@/shared/logger.util';

// Confirmed: the real User model lives at src/auth/models/User.model.ts,
// registered as mongoose.model('User', UserSchema). Rather than import
// that file directly (risking an export-name/path mismatch), this uses
// mongoose.model('User') to fetch the already-registered model — the
// same pattern already used elsewhere in this codebase, e.g.
// src/Mentorship/repositories/review.repository.ts and
// src/StudyGroup/socket/chatHandler.ts. This works as long as
// User.model.ts has been loaded somewhere before this code runs (it will
// be, since the app registers all models at startup).
const User = mongoose.model('User');

class CommunityService {
  async getTopMentors(limit: number, period: 'weekly' | 'monthly' | 'all-time', domain?: string) {
    try {
      const filter: Record<string, any> = { status: 'active' };
      if (domain) filter.domains = domain;

      const mentors = await Mentor.find(filter)
        .sort({ 'trustScore.metrics.averageRating': -1, 'trustScore.metrics.totalCompletedSessions': -1 })
        .limit(limit)
        .lean();

      // Mentor.userId is a plain UUID string, not a Mongo ObjectId ref, so
      // Mongoose .populate() can't be used here. Instead: collect the
      // userIds from the mentors we just fetched, then do one extra query
      // to pull matching User docs by their own `userId` field (confirmed
      // from the mentor-profile response: User has its own `userId` UUID
      // that matches Mentor.userId — not User._id).
      const userIds = mentors.map((m: any) => m.userId).filter(Boolean);

      const users = await User.find(
        { userId: { $in: userIds } },
        { userId: 1, firstName: 1, lastName: 1 }
      ).lean();

      const nameByUserId = new Map(
        users.map((u: any) => [u.userId, `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()])
      );

      return mentors.map((mentor: any) => ({
        mentorId: mentor.mentorId,
        userId: mentor.userId,
        name: nameByUserId.get(mentor.userId) || undefined,
        profilePic: mentor.profilePic,
        domains: mentor.domains,
        rating: mentor.trustScore?.metrics?.averageRating || 0,
        sessionsCompleted: mentor.trustScore?.metrics?.totalCompletedSessions || 0,
      }));
    } catch (error: any) {
      logger.error('Error building top mentors leaderboard:', error);
      throw error;
    }
  }

  async getCommunityStats() {
    const [totalMentors, activeMentors] = await Promise.all([
      Mentor.countDocuments({}),
      Mentor.countDocuments({ status: 'active' }), // fixed: was 'approved'
    ]);
    return { totalMentors, activeMentors };
  }
}

export default new CommunityService();