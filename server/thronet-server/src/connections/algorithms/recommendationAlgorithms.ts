import logger, { LogCategory, PublicLogMetadata } from '@/shared/logger.util';

/**
 * Recommendation Algorithms
 * Core algorithmic functions for connection recommendations (5 features as per plan).
 * Includes scoring, ranking, personalization, filtering, and optimization.
 * Used in networkService for recommendation generation.
 * 
 * Features (5 total):
 * 1. recommendConnections - Generate raw recommendations (triadic closure)
 * 2. rankRecommendations - Rank by score (mutual count, strength)
 * 3. personalizeRecommendations - Personalize based on user prefs
 * 4. filterRecommendations - Filter by criteria (location, industry)
 * 5. optimizeRecommendations - Optimize for diversity/novelty
 * 
 * Dependencies:
 * - logger: For logs
 * 
 * Scalability: Batch processing for large users
 * Integration: Called from networkService getRecommendations
 */

export class RecommendationAlgorithms {
  /**
   * Feature 1: Recommend connections (2nd degree with mutuals)
   * @param graph - Graph
   * @param userId - User
   * @returns Potential connections
   */
  recommendConnections(graph: Record<string, string[]>, userId: string): string[] {
    const first = new Set(graph[userId] || []);
    const recommendations = new Set<string>();

    for (const friend of first) {
      (graph[friend] || []).forEach(rec => {
        if (rec !== userId && !first.has(rec)) recommendations.add(rec);
      });
    }

    logger.debug('Recommendations generated', {
      userId,
      data: { count: recommendations.size },
      category: LogCategory.PERFORMANCE
    } as unknown as PublicLogMetadata);
    return Array.from(recommendations);
  }

  /**
   * Feature 2: Rank recommendations by mutual count/strength
   * @param recs - Recommendations
   * @param mutuals - Mutual data
   * @returns Ranked recs
   */
  rankRecommendations(recs: string[], mutuals: Record<string, number>): string[] {
    return recs.sort((a, b) => {
      const scoreA = mutuals[a] ?? 0; // Use nullish coalescing for type safety
      const scoreB = mutuals[b] ?? 0;
      return scoreB - scoreA;
    });
  }

  /**
   * Feature 3: Personalize based on user prefs (e.g., industry weight)
   * @param recs - Recommendations
   * @param prefs - User prefs { industry: weight, ... }
   * @param userData - User data
   * @returns Personalized ranked
   */
  personalizeRecommendations(recs: any[], prefs: Record<string, number>, userData: Record<string, any>): any[] {
    return recs
      .map(r => ({
        ...r,
        score: Object.entries(prefs).reduce((sum, [key, weight]) => sum + (r[key] === userData[key] ? weight : 0), 0),
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Feature 4: Filter recommendations (exclude blocked, etc.)
   * @param recs - Recommendations
   * @param filters - Filters { exclude: [] }
   * @returns Filtered
   */
  filterRecommendations(recs: string[], filters: { exclude: string[] }): string[] {
    const excludeSet = new Set(filters.exclude);
    return recs.filter(r => !excludeSet.has(r));
  }

  /**
   * Feature 5: Optimize for diversity (select diverse subset)
   *
   * Problem it solves: rankRecommendations/personalizeRecommendations sort by
   * score, so a naive `.slice(0, limit)` can return a list where 8 out of 10
   * suggestions are from the same company or industry, just because that
   * group happened to score highest. That looks repetitive to the user even
   * though each individual suggestion is "correct".
   *
   * Approach: round-robin bucketing (a simple, well-known diversification
   * technique — same family as Maximal Marginal Relevance, but cheaper).
   *   1. Group the already-ranked recs into buckets by a diversity key
   *      (e.g. industry, company, location — whatever the rec object has).
   *      Order *inside* each bucket is preserved, so the highest-ranked
   *      person in each group still comes out first from that group.
   *   2. Walk across the buckets in round-robin order, popping one item at
   *      a time, until `limit` items are collected.
   *
   * This guarantees no single group can dominate the output unless there
   * simply aren't enough other groups to fill the list — in which case it
   * gracefully falls back to the original ranked order (same behavior as
   * the old `.slice(0, limit)` when everything shares one bucket).
   *
   * Complexity: O(n) to bucket + O(limit) to select — safe for large batches.
   *
   * @param recs - Ranked recs (already sorted by rankRecommendations/personalizeRecommendations)
   * @param limit - Number to return
   * @param diversityKey - Field on each rec to diversify by (default: 'industry')
   * @returns Optimized, diversified subset of size <= limit
   */
  optimizeRecommendations(recs: any[], limit: number, diversityKey: string = 'industry'): any[] {
    if (!recs.length || limit <= 0) return [];

    // Step 1: bucket by diversity key, preserving existing rank order inside each bucket
    const buckets = new Map<string, any[]>();
    for (const rec of recs) {
      const key = rec?.[diversityKey] ?? 'unknown';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(rec);
    }

    const bucketKeys = Array.from(buckets.keys());
    const optimized: any[] = [];
    let bucketIndex = 0;

    // Step 2: round-robin across buckets until we hit the limit or run out of items
    while (optimized.length < limit && bucketKeys.some(k => (buckets.get(k)?.length ?? 0) > 0)) {
      const key = bucketKeys[bucketIndex % bucketKeys.length];
      const bucket = buckets.get(key)!;
      if (bucket.length > 0) {
        optimized.push(bucket.shift());
      }
      bucketIndex++;
    }

    logger.debug('Recommendations optimized for diversity', {
      data: {
        totalInput: recs.length,
        totalOutput: optimized.length,
        diversityKey,
        bucketsCount: bucketKeys.length,
      },
      category: LogCategory.PERFORMANCE
    } as unknown as PublicLogMetadata);

    return optimized;
  }
}

// Export instance
export const recommendationAlgorithms = new RecommendationAlgorithms();
export default recommendationAlgorithms;