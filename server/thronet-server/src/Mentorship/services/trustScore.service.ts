import Mentor from '../models/Mentor';
import mentorRepository from '../repositories/mentor.repository';
import MentorshipReview from '../models/MentorshipReview';
import SessionMentor from '../models/SessionMentor';
import GroupSession from '../models/GroupSession';
import { TrustScoreCalculator } from '../utils/trustScoreCalculator';
import { TrustScoreMetrics } from '../interface/trustScore.types';
import mentorshipanalyticsService from './mentorshipAnalytics.service';

export class TrustScoreService {
  /**
   * Recalculates the Trust Score for a mentor.
   * This handles fetching data, aggregating metrics, calling the calculator, and persisting the result.
   */
  public static async recalculate(mentorId: string): Promise<any> {
    try {
      const mentor = await Mentor.findOne({ mentorId });
      if (!mentor) {
        console.warn(`[TrustScore] Mentor not found for recalculation: ${mentorId}`);
        return null;
      }

      // Fetch the actual real dashboard stats from the analytics service
      const dashboardStats = await mentorshipanalyticsService.getMentorDashboardStats(mentorId);

      const metrics: TrustScoreMetrics = {
        totalSessions: dashboardStats.cancellationRate.total,
        completedSessions: dashboardStats.conversion.bookings,
        cancelledSessions: dashboardStats.cancellationRate.cancelled,
        averageRating: dashboardStats.reviews.averageRating,
        totalReviews: dashboardStats.reviews.totalReviews,
        hasTitle: !!mentor.title,
        hasBio: !!mentor.bio && mentor.bio.length >= 50,
        hasDomains: Array.isArray(mentor.domains) && mentor.domains.length > 0,
        hasSkills: Array.isArray(mentor.skills) && mentor.skills.length > 0,
        isVerified: !!mentor.verification?.isVerified,
        profileViews: dashboardStats.profileViews.value,
        conversionRate: dashboardStats.conversion.rate,
      };

      const newTrustScore = TrustScoreCalculator.calculate(metrics);

      await mentorRepository.updateByMentorId(mentorId, { trustScore: newTrustScore });

      console.info(`[TrustScore] Recalculated for Mentor ${mentorId}: Overall ${newTrustScore.overall}`);
      return newTrustScore;
    } catch (error) {
      console.error(`[TrustScore] Error recalculating for mentor ${mentorId}:`, error);
      return null;
    }
  }

  /**
   * ✅ NEW — Profile page ke liye lightweight getter.
   * userId se lookup karta hai (mentorId se nahi), kyunki profile page
   * ko sirf platform userId pata hota hai.
   *
   * Agar user mentor nahi hai, to null return karta hai — controller
   * isko `isMentor: false` me convert karke frontend ko bhejega, taaki
   * badge simply hide ho jaaye, error na dikhe.
   */
  public static async getByUserId(userId: string): Promise<any | null> {
    try {
      const mentor = await Mentor.findOne({ userId, isDeleted: false })
        .select('mentorId userId trustScore title verification stats')
        .lean();

      if (!mentor) {
        return null;
      }

      return {
        mentorId: mentor.mentorId,
        userId: mentor.userId,
        title: mentor.title,
        isVerified: mentor.verification?.isVerified || false,
        trustScore: mentor.trustScore || {
          overall: 0,
          breakdown: {
            profileCompleteness: 0,
            reliability: 0,
            studentSatisfaction: 0,
            engagement: 0,
          },
        },
        averageRating: mentor.stats?.averageRating || 0,
        totalReviews: mentor.stats?.totalReviews || 0,
      };
    } catch (error) {
      console.error(`[TrustScore] Error fetching trust score for user ${userId}:`, error);
      throw error;
    }
  }
}