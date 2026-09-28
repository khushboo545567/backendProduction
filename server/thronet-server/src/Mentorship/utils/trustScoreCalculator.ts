import { ITrustScore, TrustScoreMetrics } from '../interface/trustScore.types';
import { TRUST_SCORE_VERSION, TRUST_SCORE_WEIGHTS } from './trustScore.constants';

const TIERS = [
  { min: 90, name: "Elite Mentor", color: "#a37c2c", bg: "#fdf6e3", ring: "#e6c869" },
  { min: 75, name: "Trusted Pro", color: "#4a3728", bg: "#f3ece4", ring: "#c9a876" },
  { min: 60, name: "Rising Mentor", color: "#7a5c3e", bg: "#fbf7f3", ring: "#a08070" },
  { min: 0, name: "Getting Started", color: "#8a7a6a", bg: "#f6ede8", ring: "#d8cec4" },
];

export class TrustScoreCalculator {
  /**
   * Pure mathematical calculation engine for computing scores with safe fallbacks.
   */
  public static calculate(metrics: TrustScoreMetrics): ITrustScore {
    const profileCompleteness = this.calculateProfileCompleteness(metrics);
    const reliability = this.calculateReliability(metrics);
    const studentSatisfaction = this.calculateStudentSatisfaction(metrics);
    const engagement = this.calculateEngagement(metrics);

    let overall = Math.round(
      profileCompleteness * TRUST_SCORE_WEIGHTS.PROFILE_COMPLETENESS +
      reliability * TRUST_SCORE_WEIGHTS.RELIABILITY +
      studentSatisfaction * TRUST_SCORE_WEIGHTS.STUDENT_SATISFACTION +
      engagement * TRUST_SCORE_WEIGHTS.ENGAGEMENT
    );

    overall = Math.min(Math.max(overall, 0), 100);

    const tier = TIERS.find((t) => overall >= t.min) ?? TIERS[TIERS.length - 1];
    const higherTiers = TIERS.filter((t) => t.min > overall).sort((a, b) => a.min - b.min);
    const nextTier = higherTiers[0] ?? null;
    const pointsToNextTier = nextTier ? Math.max(nextTier.min - overall, 0) : 0;

    const improvementSuggestions = this.generateImprovementSuggestions(metrics, profileCompleteness, reliability, studentSatisfaction, engagement);

    return {
      overall,
      breakdown: {
        profileCompleteness,
        reliability,
        studentSatisfaction,
        engagement,
      },
      metrics: {
        totalCompletedSessions: metrics.completedSessions,
        totalCancelledSessions: metrics.cancelledSessions,
        averageRating: metrics.averageRating,
        reviewCount: metrics.totalReviews,
        profileViews: metrics.profileViews,
        conversionRate: metrics.conversionRate,
      },
      tier,
      nextTier,
      pointsToNextTier,
      improvementSuggestions,
      version: TRUST_SCORE_VERSION,
      lastCalculatedAt: new Date(),
    };
  }

  private static calculateProfileCompleteness(metrics: TrustScoreMetrics): number {
    let score = 0;
    const totalFields = 5;
    
    if (metrics.hasTitle) score++;
    if (metrics.hasBio) score++;
    if (metrics.hasDomains) score++;
    if (metrics.hasSkills) score++;
    if (metrics.isVerified) score++;
    
    return Math.round((score / totalFields) * 100);
  }

  private static calculateReliability(metrics: TrustScoreMetrics): number {
    if (metrics.totalSessions === 0) return 100; // Safe default for new mentors

    const completionRate = metrics.completedSessions / metrics.totalSessions;
    return Math.round(completionRate * 100);
  }

  private static calculateStudentSatisfaction(metrics: TrustScoreMetrics): number {
    if (metrics.totalReviews === 0) return 100; // Safe neutral default

    // Rating is out of 5, convert to 100-point scale
    const percentage = (metrics.averageRating / 5) * 100;
    return Math.round(Math.max(percentage, 0));
  }

  private static calculateEngagement(metrics: TrustScoreMetrics): number {
    // Engagement model based on session volume, views, and conversion rate
    let score = 0;
    
    if (metrics.completedSessions >= 50) score += 50;
    else if (metrics.completedSessions >= 20) score += 40;
    else if (metrics.completedSessions >= 5) score += 25;
    else if (metrics.completedSessions > 0) score += 10;
    
    if (metrics.profileViews >= 500) score += 20;
    else if (metrics.profileViews >= 100) score += 10;
    else if (metrics.profileViews > 0) score += 5;

    if (metrics.conversionRate >= 10) score += 30;
    else if (metrics.conversionRate >= 5) score += 20;
    else if (metrics.conversionRate > 0) score += 10;

    return Math.min(Math.round(score), 100);
  }

  private static generateImprovementSuggestions(metrics: TrustScoreMetrics, profile: number, reliability: number, satisfaction: number, engagement: number): { text: string }[] {
    const suggestions: { text: string }[] = [];

    if (profile < 100) {
      suggestions.push({ text: `Complete the remaining profile sections to reach 100% (currently ${profile}%).` });
    }

    if (metrics.completedSessions < 10) {
      const remaining = 10 - metrics.completedSessions;
      suggestions.push({ text: `Complete ${remaining} more session${remaining > 1 ? 's' : ''} to boost your engagement score.` });
    }

    if (metrics.totalReviews < 5) {
      const remaining = 5 - metrics.totalReviews;
      suggestions.push({ text: `Collect ${remaining} more review${remaining > 1 ? 's' : ''} to improve your student satisfaction score.` });
    } else if (metrics.averageRating < 4.8) {
      suggestions.push({ text: `Your average rating is ${metrics.averageRating.toFixed(1)}. Collect more high-quality reviews to improve student satisfaction.` });
    }

    if (metrics.cancelledSessions > 0) {
      suggestions.push({ text: `Reduce cancellations. You currently have ${metrics.cancelledSessions} cancelled session${metrics.cancelledSessions > 1 ? 's' : ''}.` });
    }

    if (suggestions.length === 0) {
      suggestions.push({ text: "You are doing great! Keep up the good work to maintain your Trust Score." });
    }

    return suggestions.slice(0, 4);
  }
}
