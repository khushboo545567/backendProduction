export interface ITrustScore {
  overall: number;
  breakdown: {
    profileCompleteness: number;
    reliability: number;
    studentSatisfaction: number | null;
    engagement: number;
  };
  metrics: {
    totalCompletedSessions: number;
    totalCancelledSessions: number;
    averageRating: number;
    reviewCount: number;
    profileViews: number;
    conversionRate: number;
  };
  tier: { min: number; name: string; color: string; bg: string; ring: string };
  nextTier: { min: number; name: string; color: string; bg: string; ring: string } | null;
  pointsToNextTier: number;
  improvementSuggestions: { text: string; action?: string }[];
  version: string;
  lastCalculatedAt: Date;
}

export interface TrustScoreMetrics {
  totalSessions: number;
  completedSessions: number;
  cancelledSessions: number;
  averageRating: number;
  totalReviews: number;
  hasTitle: boolean;
  hasBio: boolean;
  hasDomains: boolean;
  hasSkills: boolean;
  hasCompany: boolean;
  hasExperience: boolean;
  hasSocialLinks: boolean;
  isVerified: boolean;
  profileViews: number;
  conversionRate: number;
}
