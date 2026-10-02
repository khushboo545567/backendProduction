// File: thronet-server/src/Mentorship/services/mentorshipAnalytics.service.ts
import { Mentor, SessionMentor, MentorshipReview, PackageCredit } from "../models";
import { BookingStatus } from "@/shared/constants/bookingStatus";
import { logger } from "@/shared/logger.util";
import MentorshipAnalytics from '@/Mentorship/models/mentorshipAnalytics';

class MentorshipAnalyticsService {
  /**
   * Get comprehensive mentor statistics
   */
  async getMentorStats(mentorId: string, startDate?: Date, endDate?: Date): Promise<any> {
    try {
      logger.info(`📊 Fetching stats for mentor: ${mentorId}`);

      const dateFilter: any = {};
      if (startDate || endDate) {
        dateFilter.createdAt = {};
        if (startDate) dateFilter.createdAt.$gte = startDate;
        if (endDate) dateFilter.createdAt.$lte = endDate;
      }

      const mentor = await Mentor.findOne({ mentorId: mentorId });
      if (!mentor) {
        throw new Error('Mentor not found');
      }

      const [sessionStats, sessionTypeBreakdown, reviewStats] = await Promise.all([
        SessionMentor.aggregate([
          { $match: { mentorId } },
          {
            $unwind: { path: '$bookings', preserveNullAndEmptyArrays: true }
          },
          {
            $addFields: {
              bookingDate: { $ifNull: ['$bookings.bookedAt', '$scheduledAt'] },
              bookingTotalAmount: { $ifNull: ['$bookings.pricing.totalAmount', '$pricing.totalAmount'] },
              bookingStatus: { $ifNull: ['$bookings.status', '$status'] }
            }
          },
          {
            $addFields: {
              isValidBooking: {
                $in: ['$bookingStatus', ['confirmed', 'rescheduled', 'in_progress', 'completed']]
              }
            }
          },
          ...(Object.keys(dateFilter).length > 0 ? [{
            $match: {
              ...(startDate ? { bookingDate: { $gte: startDate } } : {}),
              ...(endDate ? { bookingDate: { $lte: endDate } } : {})
            }
          }] : []),
          {
            $group: {
              _id: null,
              totalSessions: { $sum: { $cond: ['$isValidBooking', 1, 0] } },
              completedSessions: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] } },
              cancelledSessions: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'cancelled'] }, 1, 0] } },
              totalEarnings: { $sum: { $cond: ['$isValidBooking', '$bookingTotalAmount', 0] } },
              averageSessionPrice: { $avg: { $cond: ['$isValidBooking', '$bookingTotalAmount', null] } },
            },
          },
        ]),
        SessionMentor.aggregate([
          { $match: { mentorId } },
          { $unwind: { path: '$bookings', preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              bookingDate: { $ifNull: ['$bookings.bookedAt', '$scheduledAt'] },
              bookingTotalAmount: { $ifNull: ['$bookings.pricing.totalAmount', '$pricing.totalAmount'] },
              bookingStatus: { $ifNull: ['$bookings.status', '$status'] }
            }
          },
          {
            $addFields: {
              isValidBooking: {
                $in: ['$bookingStatus', ['confirmed', 'rescheduled', 'in_progress', 'completed']]
              }
            }
          },
          { $match: { isValidBooking: true } },
          ...(Object.keys(dateFilter).length > 0 ? [{
            $match: {
              ...(startDate ? { bookingDate: { $gte: startDate } } : {}),
              ...(endDate ? { bookingDate: { $lte: endDate } } : {})
            }
          }] : []),
          { $group: { _id: '$sessionType', count: { $sum: 1 }, revenue: { $sum: '$bookingTotalAmount' } } },
        ]),
        MentorshipReview.aggregate([
          { $match: { mentorId, isDeleted: false, isPublic: true } },
          {
            $group: {
              _id: null,
              averageRating: { $avg: '$rating' },
              totalReviews: { $sum: 1 },
              distribution: { $push: '$rating' },
            },
          },
        ]),
      ]);

      const stats = sessionStats[0] || {
        totalSessions: 0,
        completedSessions: 0,
        cancelledSessions: 0,
        totalEarnings: 0,
        averageSessionPrice: 0,
      };

      const reviews = reviewStats[0] || { averageRating: 0, totalReviews: 0, distribution: [] };

      const ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      reviews.distribution.forEach((rating: number) => {
        ratingDistribution[rating as keyof typeof ratingDistribution]++;
      });

      return {
        mentor: {
          id: mentor.mentorId,
          userId: mentor.userId,
          title: mentor.title,
          status: mentor.status,
        },
        sessions: {
          total: stats.totalSessions || 0,
          completed: stats.completedSessions || 0,
          cancelled: stats.cancelledSessions || 0,
          completionRate: (stats.totalSessions || 0) > 0
            ? Math.round(((stats.completedSessions || 0) / stats.totalSessions) * 100)
            : 0,
          byType: sessionTypeBreakdown,
        },
        earnings: {
          total: stats.totalEarnings,
          average: Math.round(stats.averageSessionPrice || 0),
          currency: 'INR',
        },
        reviews: {
          averageRating: Math.round((reviews.averageRating || 0) * 10) / 10,
          totalReviews: reviews.totalReviews,
          distribution: ratingDistribution,
        },
        period: { startDate, endDate },
      };
    } catch (error: any) {
      logger.error('❌ Failed to get mentor stats:', error);
      throw error;
    }
  }

  /**
   * 📊 Dashboard stats — everything AnalyticsPage.tsx needs, ONE call
   */
  async getMentorDashboardStats(mentorId: string): Promise<any> {
    try {
      logger.info(`📊 Fetching dashboard stats for mentor: ${mentorId}`);

      const mentor = await Mentor.findOne({ mentorId });
      if (!mentor) {
        throw new Error('Mentor not found');
      }

      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const fourMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

      const [
        baseStats,
        viewsThisMonthAgg,
        viewsLastMonthAgg,
        viewsAllTimeAgg,
        durationAgg,
        monthlyEarnings,
        cancellationAgg,
        ratingTrendAgg,
      ] = await Promise.all([
        this.getMentorStats(mentorId),

        // ✅ mentor-domain views, tracked via MentorshipAnalytics (recordEvent called from mentor.controller.ts on profile GET)
        MentorshipAnalytics.getAggregatedMetrics('mentor', mentorId, thisMonthStart, now),
        MentorshipAnalytics.getAggregatedMetrics('mentor', mentorId, lastMonthStart, thisMonthStart),
        MentorshipAnalytics.getAggregatedMetrics('mentor', mentorId, new Date(0), now),

        SessionMentor.aggregate([
          { $match: { mentorId, status: BookingStatus.COMPLETED } },
          { $group: { _id: null, avgDuration: { $avg: '$duration' } } },
        ]),

        SessionMentor.aggregate([
          { $match: { mentorId } },
          { $unwind: { path: '$bookings', preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              bookingDate: { $ifNull: ['$bookings.bookedAt', '$scheduledAt'] },
              bookingTotalAmount: { $ifNull: ['$bookings.pricing.totalAmount', '$pricing.totalAmount'] },
              bookingStatus: { $ifNull: ['$bookings.status', '$status'] }
            }
          },
          {
            $match: {
              'bookingStatus': { $in: ['confirmed', 'rescheduled', 'in_progress', 'completed'] },
              bookingDate: { $gte: fourMonthsAgo },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$bookingDate' } },
              amount: { $sum: '$bookingTotalAmount' },
              bookings: { $sum: 1 },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 4 },
        ]),

        // ✅ NEW: cancellation / no-show rate (all-time, mirrors completionRate calc)
        // NOTE: if BookingStatus has no 'no_show' member, this $cond will just
        // never match and noShow will stay 0 — safe no-op, doesn't break anything.
        SessionMentor.aggregate([
          { $match: { mentorId } },
          { $unwind: { path: '$bookings', preserveNullAndEmptyArrays: true } },
          {
            $addFields: {
              bookingStatus: { $ifNull: ['$bookings.status', '$status'] }
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              cancelled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'cancelled'] }, 1, 0] } },
              noShow: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no_show'] }, 1, 0] } },
            },
          },
        ]),

        // ✅ NEW: rating trend — monthly avg rating, last 6 months
        MentorshipReview.aggregate([
          { $match: { mentorId, isDeleted: false, isPublic: true, createdAt: { $gte: sixMonthsAgo } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
              avgRating: { $avg: '$rating' },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),
      ]);

      const viewsNow = viewsThisMonthAgg?.totalViews || 0;
      const viewsPrev = viewsLastMonthAgg?.totalViews || 0;
      const viewsChangePct = viewsPrev > 0
        ? Math.round(((viewsNow - viewsPrev) / viewsPrev) * 100)
        : viewsNow > 0 ? 100 : 0;

      const cancellation = cancellationAgg[0] || { total: 0, cancelled: 0, noShow: 0 };
      const cancellationRate = cancellation.total > 0
        ? Math.round((cancellation.cancelled / cancellation.total) * 100)
        : 0;

      // Conversion: profile views (all-time) → total bookings
      const totalBookingsAllTime = baseStats.sessions.total || 0;
      const totalViewsAllTime = viewsAllTimeAgg?.totalViews || 0;
      const viewToBookingRate = totalViewsAllTime > 0
        ? Math.round((totalBookingsAllTime / totalViewsAllTime) * 100)
        : 0;

      return {
        profileViews: {
          value: totalViewsAllTime,
          valueThisMonth: viewsNow,
          changePercent: viewsChangePct,
          trend: viewsChangePct >= 0 ? 'up' : 'down',
        },
        bookingRate: {
          value: baseStats.sessions.completionRate,
          trend: 'up',
        },
        avgSessionDuration: {
          value: Math.round(durationAgg[0]?.avgDuration || 0),
        },
        // ✅ NEW
        cancellationRate: {
          value: cancellationRate,
          cancelled: cancellation.cancelled,
          noShow: cancellation.noShow,
          total: cancellation.total,
        },
        // ✅ NEW
        conversion: {
          views: totalViewsAllTime,
          bookings: totalBookingsAllTime,
          rate: viewToBookingRate,
        },
        popularServices: baseStats.sessions.byType.map((s: any) => ({
          sessionType: s._id,
          bookings: s.count,
          revenue: s.revenue, // was already computed by getMentorStats, now actually returned to frontend
        })),
        monthlyEarnings: monthlyEarnings.map((m: any) => ({
          month: m._id,
          amount: m.amount,
          bookings: m.bookings,
        })),
        // ✅ NEW
        ratingTrend: ratingTrendAgg.map((r: any) => ({
          month: r._id,
          avgRating: Math.round((r.avgRating || 0) * 10) / 10,
          count: r.count,
        })),
        reviews: baseStats.reviews,
      };
    } catch (error: any) {
      logger.error('❌ Failed to get dashboard stats:', error);
      throw error;
    }
  }

  /**
   * Get platform-wide statistics
   */
  async getPlatformStats(startDate?: Date, endDate?: Date): Promise<any> {
    try {
      logger.info('📊 Fetching platform statistics');

      const dateFilter: any = {};
      if (startDate || endDate) {
        dateFilter.createdAt = {};
        if (startDate) dateFilter.createdAt.$gte = startDate;
        if (endDate) dateFilter.createdAt.$lte = endDate;
      }

      const [mentorStats, sessionStats, reviewStats] = await Promise.all([
        Mentor.aggregate([
          { $match: { isDeleted: false, ...dateFilter } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
              pending: { $sum: { $cond: [{ $eq: ['$status', 'pending_approval'] }, 1, 0] } },
            },
          },
        ]),
        SessionMentor.aggregate([
          { $match: dateFilter },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', BookingStatus.COMPLETED] }, 1, 0] } },
              cancelled: { $sum: { $cond: [{ $eq: ['$status', BookingStatus.CANCELLED] }, 1, 0] } },
              totalRevenue: { $sum: '$pricing.totalAmount' },
              platformFees: { $sum: '$pricing.platformFee' },
            },
          },
        ]),
        MentorshipReview.aggregate([
          { $match: { isDeleted: false, isPublic: true, ...dateFilter } },
          { $group: { _id: null, total: { $sum: 1 }, averageRating: { $avg: '$rating' } } },
        ]),
      ]);

      return {
        mentors: mentorStats[0] || { total: 0, active: 0, pending: 0 },
        sessions: sessionStats[0] || { total: 0, completed: 0, cancelled: 0, totalRevenue: 0, platformFees: 0 },
        reviews: reviewStats[0] || { total: 0, averageRating: 0 },
        period: { startDate, endDate },
      };
    } catch (error: any) {
      logger.error('❌ Failed to get platform stats:', error);
      throw error;
    }
  }

  /**
   * Get revenue report
   */
  async getRevenueReport(
    startDate?: Date,
    endDate?: Date,
    groupBy: 'day' | 'week' | 'month' = 'day'
  ): Promise<any> {
    try {
      logger.info('💰 Generating revenue report');

      const dateFilter: any = { 'payment.status': 'COMPLETED' };
      if (startDate || endDate) {
        dateFilter['payment.paidAt'] = {};
        if (startDate) dateFilter['payment.paidAt'].$gte = startDate;
        if (endDate) dateFilter['payment.paidAt'].$lte = endDate;
      }

      let groupByFormat: any;
      switch (groupBy) {
        case 'day':
          groupByFormat = { $dateToString: { format: '%Y-%m-%d', date: '$payment.paidAt' } };
          break;
        case 'week':
          groupByFormat = { $week: '$payment.paidAt' };
          break;
        case 'month':
          groupByFormat = { $dateToString: { format: '%Y-%m', date: '$payment.paidAt' } };
          break;
      }

      const result = await SessionMentor.aggregate([
        { $match: dateFilter },
        {
          $facet: {
            breakdown: [
              {
                $group: {
                  _id: groupByFormat,
                  totalRevenue: { $sum: '$pricing.totalAmount' },
                  platformFees: { $sum: '$pricing.platformFee' },
                  mentorEarnings: { $sum: '$pricing.basePrice' },
                  sessionCount: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
            summary: [
              {
                $group: {
                  _id: null,
                  totalRevenue: { $sum: '$pricing.totalAmount' },
                  platformFees: { $sum: '$pricing.platformFee' },
                  mentorEarnings: { $sum: '$pricing.basePrice' },
                  sessionCount: { $sum: 1 },
                },
              },
            ],
          },
        },
      ]);

      return {
        summary: result[0].summary[0] || {
          totalRevenue: 0,
          platformFees: 0,
          mentorEarnings: 0,
          sessionCount: 0,
        },
        breakdown: result[0].breakdown,
        groupBy,
        period: { startDate, endDate },
      };
    } catch (error: any) {
      logger.error('❌ Failed to generate revenue report:', error);
      throw error;
    }
  }

  /**
   * Get session report
   */
  async getSessionReport(
    startDate?: Date,
    endDate?: Date,
    groupBy: 'day' | 'week' | 'month' | 'type' = 'day'
  ): Promise<any> {
    try {
      logger.info('📋 Generating session report');

      const dateFilter: any = {};
      if (startDate || endDate) {
        dateFilter.scheduledAt = {};
        if (startDate) dateFilter.scheduledAt.$gte = startDate;
        if (endDate) dateFilter.scheduledAt.$lte = endDate;
      }

      let groupByField: any;
      if (groupBy === 'type') {
        groupByField = '$sessionType';
      } else {
        switch (groupBy) {
          case 'day':
            groupByField = { $dateToString: { format: '%Y-%m-%d', date: '$scheduledAt' } };
            break;
          case 'week':
            groupByField = { $week: '$scheduledAt' };
            break;
          case 'month':
            groupByField = { $dateToString: { format: '%Y-%m', date: '$scheduledAt' } };
            break;
        }
      }

      const report = await SessionMentor.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: groupByField,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', BookingStatus.COMPLETED] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$status', BookingStatus.CANCELLED] }, 1, 0] } },
            revenue: { $sum: '$pricing.totalAmount' },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      return { breakdown: report, groupBy, period: { startDate, endDate } };
    } catch (error: any) {
      logger.error('❌ Failed to generate session report:', error);
      throw error;
    }
  }
}

export default new MentorshipAnalyticsService();