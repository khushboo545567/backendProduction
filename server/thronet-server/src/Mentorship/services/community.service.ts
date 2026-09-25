import Mentor from '@/Mentorship/models/Mentor';
import { logger } from '@/shared/logger.util';

class CommunityService {
  async getTopMentors(limit: number, period: 'weekly' | 'monthly' | 'all-time', domain?: string) {
    try {
      const filter: Record<string, any> = { status: 'approved' };
      if (domain) filter.domains = domain;

      const mentors = await Mentor.find(filter)
        .sort({ 'trustScore.metrics.averageRating': -1, 'trustScore.metrics.totalCompletedSessions': -1 })
        .limit(limit)
        .lean();

      return mentors.map((mentor: any) => ({
        mentorId: mentor.mentorId,
        userId: mentor.userId,
        name: mentor.name || mentor.fullName,
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
      Mentor.countDocuments({ status: 'approved' }),
    ]);
    return { totalMentors, activeMentors };
  }
}

export default new CommunityService();