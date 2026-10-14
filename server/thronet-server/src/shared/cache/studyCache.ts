/**
 * studyCache.ts
 * Item I: Leaderboards & Study Analytics Caching Module
 *
 * Rules Enforced:
 * 1. Redis key naming:
 *    - User stats: app:v1:analytics:stats:<userId> (TTL: 900s + jitter)
 *    - Study patterns: app:v1:analytics:patterns:<userId>:days:<days> (TTL: 1800s + jitter)
 *    - Global leaderboard sorted set: app:v1:leaderboard:global (TTL: 86400s)
 *    - Category leaderboard sorted set: app:v1:leaderboard:category:<category>
 *    - Weekly leaderboard sorted set: app:v1:leaderboard:weekly
 *    - Monthly leaderboard sorted set: app:v1:leaderboard:monthly
 * 2. Per-user analytics cache: never shared across users.
 * 3. Leaderboards as Redis Sorted Sets:
 *    - ZADD / ZREVRANGE / ZREVRANK
 *    - Rebuild-from-MongoDB on startup and on miss.
 *    - Tie-breaking semantics: exact match with MongoDB (score desc, userId desc).
 * 4. User lifecycle sync:
 *    - ZREM on user deletion or deactivation.
 * 5. Kill switches:
 *    - CACHE_ANALYTICS_ENABLED, CACHE_LEADERBOARD_ENABLED.
 * 6. Fallback to MongoDB on any error or missing cache.
 */

import { buildKey, applyJitter, isCacheEnabled, CacheHelper } from './cacheHelper';
import { getRedisClient } from './redisConnection';
import { LoggerUtil } from '@/shared/logger.util';
import Ranking from '@/StudyGroup/models/Ranking.model';

const ANALYTICS_DOMAIN = 'analytics';
const LEADERBOARD_DOMAIN = 'leaderboard';

const STATS_TTL_SECONDS = parseInt(
  process.env['ANALYTICS_STATS_CACHE_TTL_SECONDS'] || '900',
  10
);
const PATTERNS_TTL_SECONDS = parseInt(
  process.env['ANALYTICS_PATTERNS_CACHE_TTL_SECONDS'] || '1800',
  10
);
const LEADERBOARD_SET_TTL_SECONDS = 86400; // 24 hours

// ============================================================================
// 1. PER-USER STUDY ANALYTICS CACHE
// ============================================================================

export class StudyAnalyticsCacheRepository {
  static getStatsKey(userId: string): string {
    return buildKey(ANALYTICS_DOMAIN, `stats:${userId}`);
  }

  static getPatternsKey(userId: string, days: number): string {
    return buildKey(ANALYTICS_DOMAIN, `patterns:${userId}:days:${days}`);
  }

  /**
   * Get cached user statistics, or compute and cache.
   */
  static async getUserStats(
    userId: string,
    computeFn: (uid: string) => Promise<any>
  ): Promise<any> {
    if (!isCacheEnabled(ANALYTICS_DOMAIN) || !userId) {
      return computeFn(userId);
    }

    const key = this.getStatsKey(userId);
    const cached = await CacheHelper.get<any>(key, ANALYTICS_DOMAIN);
    if (cached !== null) {
      return cached;
    }

    const stats = await computeFn(userId);
    if (stats) {
      await CacheHelper.set(key, stats, {
        ttlSeconds: applyJitter(STATS_TTL_SECONDS),
        domain: ANALYTICS_DOMAIN,
      });
    }
    return stats;
  }

  /**
   * Get cached study patterns, or compute and cache.
   */
  static async getStudyPatterns(
    userId: string,
    days: number,
    computeFn: (uid: string, d: number) => Promise<any>
  ): Promise<any> {
    if (!isCacheEnabled(ANALYTICS_DOMAIN) || !userId) {
      return computeFn(userId, days);
    }

    const key = this.getPatternsKey(userId, days);
    const cached = await CacheHelper.get<any>(key, ANALYTICS_DOMAIN);
    if (cached !== null) {
      return cached;
    }

    const patterns = await computeFn(userId, days);
    if (patterns) {
      await CacheHelper.set(key, patterns, {
        ttlSeconds: applyJitter(PATTERNS_TTL_SECONDS),
        domain: ANALYTICS_DOMAIN,
      });
    }
    return patterns;
  }

  /**
   * Invalidate user's analytics cache on mutations (study session, task, goal, streak).
   */
  static async invalidateUserAnalytics(userId: string): Promise<void> {
    if (!userId) return;
    try {
      const statsKey = this.getStatsKey(userId);
      // Delete stats and common day patterns (7, 14, 30, 90)
      const patternKeys = [7, 14, 30, 90].map((d) => this.getPatternsKey(userId, d));
      await CacheHelper.del([statsKey, ...patternKeys], ANALYTICS_DOMAIN);
    } catch (err: any) {
      LoggerUtil.warn('StudyAnalyticsCache: failed to invalidate user analytics', {
        userId,
        error: err.message,
      });
    }
  }
}

// ============================================================================
// 2. LEADERBOARDS REDIS SORTED SETS ACCELERATOR
// ============================================================================

export class LeaderboardCacheRepository {
  static getGlobalSetKey(): string {
    return buildKey(LEADERBOARD_DOMAIN, 'global');
  }

  static getCategorySetKey(category: string): string {
    return buildKey(LEADERBOARD_DOMAIN, `category:${category}`);
  }

  static getWeeklySetKey(): string {
    return buildKey(LEADERBOARD_DOMAIN, 'weekly');
  }

  static getMonthlySetKey(): string {
    return buildKey(LEADERBOARD_DOMAIN, 'monthly');
  }

  private static inFlightRebuilds = new Map<string, Promise<any>>();

  /**
   * Ensure global leaderboard key exists in Redis; if expired/missing, rebuild from MongoDB first (single-flight).
   */
  static async ensureGlobalLeaderboardExists(): Promise<void> {
    if (!isCacheEnabled(LEADERBOARD_DOMAIN)) return;
    try {
      const redis = await getRedisClient();
      const key = this.getGlobalSetKey();
      const exists = await redis.exists(key);
      if (exists === 1) return;

      if (!this.inFlightRebuilds.has(key)) {
        const p = this.rebuildGlobalLeaderboard().finally(() => {
          this.inFlightRebuilds.delete(key);
        });
        this.inFlightRebuilds.set(key, p);
      }
      await this.inFlightRebuilds.get(key);
    } catch (err: any) {
      LoggerUtil.warn('LeaderboardCache: failed to ensure global leaderboard exists', { error: err.message });
    }
  }

  /**
   * Rebuild the global leaderboard sorted set directly from MongoDB authoritative rankings.
   * Deterministic tie-breaking: score descending, then userId ascending (matching Redis lexicographical order).
   */
  static async rebuildGlobalLeaderboard(): Promise<number> {
    try {
      const rankings = await Ranking.find({ rankScore: { $gt: 0 } })
        .sort({ rankScore: -1, userId: -1 })
        .select('userId rankScore')
        .lean()
        .exec();

      if (!isCacheEnabled(LEADERBOARD_DOMAIN)) return rankings.length;

      const redis = await getRedisClient();
      const key = this.getGlobalSetKey();

      const pipeline = redis.pipeline();
      pipeline.del(key);

      if (rankings.length > 0) {
        // ZADD in batches of 500
        for (let i = 0; i < rankings.length; i += 500) {
          const batch = rankings.slice(i, i + 500);
          const args: (string | number)[] = [];
          for (const r of batch) {
            if (r.userId && r.rankScore !== undefined) {
              args.push(r.rankScore, String(r.userId));
            }
          }
          if (args.length > 0) {
            pipeline.zadd(key, ...(args as any));
          }
        }
      }
      pipeline.expire(key, LEADERBOARD_SET_TTL_SECONDS);
      await pipeline.exec();

      LoggerUtil.info('LeaderboardCache: global leaderboard rebuilt from MongoDB', {
        count: rankings.length,
      });
      return rankings.length;
    } catch (err: any) {
      LoggerUtil.error('LeaderboardCache: failed to rebuild global leaderboard from MongoDB', {
        error: err.message,
      });
      return 0;
    }
  }

  /**
   * Rebuild all dimension leaderboards (global, category, weekly, monthly).
   */
  static async rebuildAllLeaderboards(): Promise<void> {
    try {
      await this.rebuildGlobalLeaderboard();
      // Also rebuild weekly & monthly
      const [weeklyRankings, monthlyRankings] = await Promise.all([
        Ranking.find({ weeklyHours: { $gt: 0 } })
          .sort({ weeklyHours: -1, userId: -1 })
          .select('userId weeklyHours')
          .lean()
          .exec(),
        Ranking.find({ monthlyHours: { $gt: 0 } })
          .sort({ monthlyHours: -1, userId: -1 })
          .select('userId monthlyHours')
          .lean()
          .exec(),
      ]);

      if (isCacheEnabled(LEADERBOARD_DOMAIN)) {
        const redis = await getRedisClient();
        const weeklyKey = this.getWeeklySetKey();
        const monthlyKey = this.getMonthlySetKey();

        const pipeline = redis.pipeline();
        pipeline.del(weeklyKey);
        pipeline.del(monthlyKey);

        if (weeklyRankings.length > 0) {
          const wArgs: (string | number)[] = [];
          for (const r of weeklyRankings) {
            if (r.userId && r.weeklyHours) wArgs.push(r.weeklyHours, String(r.userId));
          }
          if (wArgs.length > 0) pipeline.zadd(weeklyKey, ...(wArgs as any));
        }

        if (monthlyRankings.length > 0) {
          const mArgs: (string | number)[] = [];
          for (const r of monthlyRankings) {
            if (r.userId && r.monthlyHours) mArgs.push(r.monthlyHours, String(r.userId));
          }
          if (mArgs.length > 0) pipeline.zadd(monthlyKey, ...(mArgs as any));
        }

        pipeline.expire(weeklyKey, LEADERBOARD_SET_TTL_SECONDS);
        pipeline.expire(monthlyKey, LEADERBOARD_SET_TTL_SECONDS);
        await pipeline.exec();
      }
    } catch (err: any) {
      LoggerUtil.warn('LeaderboardCache: failed to rebuild all leaderboards', {
        error: err.message,
      });
    }
  }

  /**
   * Get a page of the global leaderboard from Redis Sorted Set.
   * On cache miss, rebuilds from MongoDB.
   */
  static async getGlobalLeaderboardPage(
    skip: number,
    limit: number
  ): Promise<{ userIds: string[]; scores: number[]; total: number } | null> {
    if (!isCacheEnabled(LEADERBOARD_DOMAIN)) return null;

    try {
      const redis = await getRedisClient();
      const key = this.getGlobalSetKey();

      let exists = await redis.exists(key);
      if (!exists) {
        // Cache miss: rebuild from MongoDB
        await this.rebuildGlobalLeaderboard();
      }

      const total = await redis.zcard(key);
      if (total === 0) {
        return { userIds: [], scores: [], total: 0 };
      }

      const stop = skip + limit - 1;
      const resultsWithScores = await redis.zrevrange(key, skip, stop, 'WITHSCORES');

      const userIds: string[] = [];
      const scores: number[] = [];
      for (let i = 0; i < resultsWithScores.length; i += 2) {
        userIds.push(resultsWithScores[i]);
        scores.push(parseFloat(resultsWithScores[i + 1]));
      }

      return { userIds, scores, total };
    } catch (err: any) {
      LoggerUtil.warn('LeaderboardCache: Redis error in getGlobalLeaderboardPage, falling back to MongoDB', {
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Get a user's rank and score in the global leaderboard.
   * Returns 1-based rank (0 rank means unranked).
   */
  static async getUserGlobalRank(
    userId: string
  ): Promise<{ rank: number; score: number } | null> {
    if (!isCacheEnabled(LEADERBOARD_DOMAIN) || !userId) return null;

    try {
      const redis = await getRedisClient();
      const key = this.getGlobalSetKey();

      let exists = await redis.exists(key);
      if (!exists) {
        await this.rebuildGlobalLeaderboard();
      }

      const [revRank, scoreStr] = await Promise.all([
        redis.zrevrank(key, userId),
        redis.zscore(key, userId),
      ]);

      if (revRank === null || scoreStr === null) {
        return null;
      }

      return {
        rank: revRank + 1, // Convert 0-based to 1-based
        score: parseFloat(scoreStr),
      };
    } catch (err: any) {
      LoggerUtil.warn('LeaderboardCache: Redis error in getUserGlobalRank, falling back to MongoDB', {
        userId,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Update a user's score in sorted sets (called when ranking metrics change).
   */
  static async updateUserScore(
    userId: string,
    rankScore: number,
    category?: string,
    weeklyHours?: number,
    monthlyHours?: number
  ): Promise<void> {
    if (!isCacheEnabled(LEADERBOARD_DOMAIN) || !userId) return;

    try {
      const redis = await getRedisClient();
      const globalKey = this.getGlobalSetKey();

      if (rankScore > 0) {
        // Must never run ZADD on a missing or expired key - rebuild from MongoDB first
        await this.ensureGlobalLeaderboardExists();
      }

      const pipeline = redis.pipeline();
      if (rankScore > 0) {
        pipeline.zadd(globalKey, rankScore, userId);
        pipeline.expire(globalKey, LEADERBOARD_SET_TTL_SECONDS);
      } else {
        pipeline.zrem(globalKey, userId);
      }

      if (category) {
        const catKey = this.getCategorySetKey(category);
        if (rankScore > 0) {
          pipeline.zadd(catKey, rankScore, userId);
          pipeline.expire(catKey, LEADERBOARD_SET_TTL_SECONDS);
        } else {
          pipeline.zrem(catKey, userId);
        }
      }

      if (weeklyHours !== undefined) {
        const weeklyKey = this.getWeeklySetKey();
        if (weeklyHours > 0) {
          pipeline.zadd(weeklyKey, weeklyHours, userId);
          pipeline.expire(weeklyKey, LEADERBOARD_SET_TTL_SECONDS);
        } else {
          pipeline.zrem(weeklyKey, userId);
        }
      }

      if (monthlyHours !== undefined) {
        const monthlyKey = this.getMonthlySetKey();
        if (monthlyHours > 0) {
          pipeline.zadd(monthlyKey, monthlyHours, userId);
          pipeline.expire(monthlyKey, LEADERBOARD_SET_TTL_SECONDS);
        } else {
          pipeline.zrem(monthlyKey, userId);
        }
      }

      await pipeline.exec();
    } catch (err: any) {
      LoggerUtil.warn('LeaderboardCache: failed to update user score in sorted sets', {
        userId,
        error: err.message,
      });
    }
  }

  /**
   * Remove user from all leaderboards (on user deletion or deactivation).
   */
  static async removeUser(userId: string): Promise<void> {
    if (!userId) return;
    try {
      const redis = await getRedisClient();
      const globalKey = this.getGlobalSetKey();
      const weeklyKey = this.getWeeklySetKey();
      const monthlyKey = this.getMonthlySetKey();

      const pipeline = redis.pipeline();
      pipeline.zrem(globalKey, userId);
      pipeline.zrem(weeklyKey, userId);
      pipeline.zrem(monthlyKey, userId);
      await pipeline.exec();
      LoggerUtil.info(`LeaderboardCache: removed user ${userId} from sorted sets`);
    } catch (err: any) {
      LoggerUtil.warn('LeaderboardCache: failed to remove user from leaderboards', {
        userId,
        error: err.message,
      });
    }
  }
}
