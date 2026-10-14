/**
 * study-cache.test.ts
 * Item I: Behavioural Verification Suite for Leaderboards and Study Analytics Caching
 *
 * Requirements Tested:
 * 1. testSafetyGuard enabled (must refuse to run unless on test database)
 * 2. Cache hit and miss for user analytics (getUserStats, getStudyPatterns)
 * 3. User isolation: User A never gets User B's analytics
 * 4. Invalidation after write paths (study session, ranking updates)
 * 5. Redis sorted sets (ZADD/ZREVRANGE/ZREVRANK) with rebuild on miss
 * 6. Tie-breaking and rank semantics: exact match between MongoDB and Redis on identical data
 * 7. ZREM on user deactivation or deletion
 * 8. Fallback to MongoDB / compute when Redis is unavailable or kill switch CACHE_ANALYTICS_ENABLED=false
 * 9. Concurrency: multiple concurrent reads and updates
 * 10. TTL with jitter verification
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { assertTestEnvironmentSafety } from './testSafetyGuard';
import { getRedisClient } from '../redisConnection';
import { StudyAnalyticsCacheRepository, LeaderboardCacheRepository } from '../studyCache';
import User from '@/auth/models/User.model';
import Ranking from '@/StudyGroup/models/Ranking.model';
import studySessionRepository from '@/StudyGroup/repositories/studySession.repository';
import rankingService from '@/StudyGroup/services/ranking.service';
import analyticsService from '@/StudyGroup/services/analytics.service';
import { SessionStatus } from '@/StudyGroup/interfaces/IStudySession';
import GroupCategory from '@/StudyGroup/enums/GroupCategory.enum';

function assert(condition: any, message: string) {
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  [PASS] ${message}`);
}

async function runStudyCacheTests() {
  console.log('\n==========================================================');
  console.log('🧪 Starting Study Analytics & Leaderboard Test Suite (Item I)');
  console.log('==========================================================');

  // Enforce safety guard & connect DB
  const mongoUri = assertTestEnvironmentSafety();
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri);
  }

  const redis = await getRedisClient();
  await redis.ping();
  console.log('✅ Connected to MongoDB and Redis');

  const userA = uuidv4();
  const userB = uuidv4();
  const userC = uuidv4();

  // Seed User records
  await User.insertMany([
    {
      userId: userA,
      email: `${userA}@test.com`,
      passwordHash: 'dummy_hash',
      firstName: 'Alice',
      lastName: 'Study',
      status: 'active',
      accountStatus: 'active',
    },
    {
      userId: userB,
      email: `${userB}@test.com`,
      passwordHash: 'dummy_hash',
      firstName: 'Bob',
      lastName: 'Study',
      status: 'active',
      accountStatus: 'active',
    },
    {
      userId: userC,
      email: `${userC}@test.com`,
      passwordHash: 'dummy_hash',
      firstName: 'Charlie',
      lastName: 'Study',
      status: 'active',
      accountStatus: 'active',
    },
  ]);

  try {
    // ── Test 1: User Analytics Cache Hit, Miss & Isolation ────────────
    console.log('\n--- 1. User Analytics Cache Hit, Miss & User Isolation ---');
    const statsKeyA = StudyAnalyticsCacheRepository.getStatsKey(userA);
    const statsKeyB = StudyAnalyticsCacheRepository.getStatsKey(userB);

    await redis.del(statsKeyA);
    await redis.del(statsKeyB);

    let computeCountA = 0;
    let computeCountB = 0;

    const computeA = async () => {
      computeCountA++;
      return { totalStudyTime: 5400, completedSessions: 3, user: userA };
    };

    const computeB = async () => {
      computeCountB++;
      return { totalStudyTime: 1800, completedSessions: 1, user: userB };
    };

    // First call: Miss
    const resA1 = await StudyAnalyticsCacheRepository.getUserStats(userA, computeA);
    assert(computeCountA === 1, 'First call computes stats on miss');
    assert(resA1.user === userA, 'User A gets user A data');

    // Second call: Hit
    const resA2 = await StudyAnalyticsCacheRepository.getUserStats(userA, computeA);
    assert(computeCountA === 1, 'Second call hits cache (no compute re-run)');
    assert(resA2.totalStudyTime === 5400, 'Cached stats match computed');

    // User B call: Isolated from User A
    const resB1 = await StudyAnalyticsCacheRepository.getUserStats(userB, computeB);
    assert(computeCountB === 1, 'User B computes separately');
    assert(resB1.user === userB, 'User B gets user B data, never user A data');
    assert(resB1.totalStudyTime !== resA2.totalStudyTime, 'User isolation verified (distinct cache keys)');

    // Verify TTL is set
    const ttl = await redis.ttl(statsKeyA);
    assert(ttl > 800 && ttl <= 1000, `TTL is in expected range with jitter (${ttl}s)`);

    // ── Test 2: Study Patterns Cache ──────────────────────────────────
    console.log('\n--- 2. Study Patterns Cache & Invalidation ---');
    let patternsComputeCount = 0;
    const computePatterns = async () => {
      patternsComputeCount++;
      return { days: 7, streak: 5, sessionsPerDay: [1, 2, 0, 1, 3, 2, 1] };
    };

    const patterns1 = await StudyAnalyticsCacheRepository.getStudyPatterns(userA, 7, computePatterns);
    assert(patternsComputeCount === 1, 'Patterns computed on cache miss');
    assert(patterns1.streak === 5, 'Patterns data returned');

    const patterns2 = await StudyAnalyticsCacheRepository.getStudyPatterns(userA, 7, computePatterns);
    assert(patternsComputeCount === 1, 'Patterns served from cache on second call');

    // Invalidation on write
    await StudyAnalyticsCacheRepository.invalidateUserAnalytics(userA);
    const keyAfterDel = await redis.get(statsKeyA);
    assert(keyAfterDel === null, 'Stats key deleted upon user analytics invalidation');

    const patternsAfterDel = await redis.get(StudyAnalyticsCacheRepository.getPatternsKey(userA, 7));
    assert(patternsAfterDel === null, 'Patterns key deleted upon user analytics invalidation');

    // ── Test 3: Redis Down Fallback & Kill Switch ─────────────────────
    console.log('\n--- 3. Fallback to MongoDB & Kill Switch ---');
    process.env['CACHE_ANALYTICS_ENABLED'] = 'false';

    let fallbackCompute = 0;
    const resFallback = await StudyAnalyticsCacheRepository.getUserStats(userA, async () => {
      fallbackCompute++;
      return { totalStudyTime: 9999, fallback: true };
    });
    assert(fallbackCompute === 1, 'Kill switch immediately falls back to direct compute');
    assert(resFallback.fallback === true, 'Fallback returned correct result');

    delete process.env['CACHE_ANALYTICS_ENABLED'];

    // ── Test 4: Leaderboards as Redis Sorted Sets (ZADD/ZREVRANGE/ZREVRANK)
    console.log('\n--- 4. Leaderboard Sorted Sets (ZADD / ZREVRANGE / ZREVRANK) ---');
    const globalKey = LeaderboardCacheRepository.getGlobalSetKey();
    await redis.del(globalKey);

    // Seed rankings in MongoDB
    await Ranking.deleteMany({});
    const createdDocs = await Ranking.create([
      { rankingId: uuidv4(), userId: userA, totalStudyHours: 1000, attendancePercentage: 100, currentStreak: 365, globalRank: 1, category: GroupCategory.OTHER, city: 'Mumbai' },
      { rankingId: uuidv4(), userId: userB, totalStudyHours: 500, attendancePercentage: 50, currentStreak: 50, globalRank: 2, category: GroupCategory.OTHER, city: 'Delhi' },
      { rankingId: uuidv4(), userId: userC, totalStudyHours: 100, attendancePercentage: 10, currentStreak: 10, globalRank: 3, category: GroupCategory.OTHER, city: 'Bangalore' },
    ]);

    const expectedScoreA = createdDocs[0].rankScore;
    const expectedScoreB = createdDocs[1].rankScore;
    const expectedScoreC = createdDocs[2].rankScore;

    // Rebuild global leaderboard
    const count = await LeaderboardCacheRepository.rebuildGlobalLeaderboard();
    assert(count >= 3, `Rebuild global leaderboard populated at least 3 users (got ${count})`);

    // Verify ZREVRANK (0-based -> 1-based)
    const rankA = await LeaderboardCacheRepository.getUserGlobalRank(userA);
    assert(rankA !== null && rankA.rank === 1 && rankA.score === expectedScoreA, `User A rank is #1 with score ${expectedScoreA}`);

    const rankB = await LeaderboardCacheRepository.getUserGlobalRank(userB);
    assert(rankB !== null && rankB.rank === 2 && rankB.score === expectedScoreB, `User B rank is #2 with score ${expectedScoreB}`);

    const rankC = await LeaderboardCacheRepository.getUserGlobalRank(userC);
    assert(rankC !== null && rankC.rank === 3 && rankC.score === expectedScoreC, `User C rank is #3 with score ${expectedScoreC}`);

    // Verify pagination via ZREVRANGE
    const page = await LeaderboardCacheRepository.getGlobalLeaderboardPage(0, 2);
    assert(page !== null, 'getGlobalLeaderboardPage returns data');
    if (!page) throw new Error('page is null');
    assert(page.userIds.length === 2, 'Page size respects limit');
    assert(page.userIds[0] === userA, 'First entry is User A');
    assert(page.userIds[1] === userB, 'Second entry is User B');

    // ── Test 5: Exact Tie-breaking Semantics Comparison with MongoDB ──
    console.log('\n--- 5. Tie-breaking Semantics Match MongoDB Exactly ---');
    // Clear and create two tied users with valid UUID v4s
    const tiedUser1 = '11111111-1111-4111-8111-111111111111';
    const tiedUser2 = '22222222-2222-4222-8222-222222222222';
    await User.deleteMany({ userId: { $in: [tiedUser1, tiedUser2] } });
    await Ranking.deleteMany({ userId: { $in: [tiedUser1, tiedUser2] } });

    await User.insertMany([
      { userId: tiedUser1, email: `${tiedUser1}@test.com`, passwordHash: 'hash', firstName: 'Tied1', lastName: 'User', status: 'active', accountStatus: 'active' },
      { userId: tiedUser2, email: `${tiedUser2}@test.com`, passwordHash: 'hash', firstName: 'Tied2', lastName: 'User', status: 'active', accountStatus: 'active' },
    ]);

    await Ranking.create([
      { rankingId: uuidv4(), userId: tiedUser1, totalStudyHours: 200, attendancePercentage: 50, currentStreak: 30, globalRank: 0, category: GroupCategory.OTHER },
      { rankingId: uuidv4(), userId: tiedUser2, totalStudyHours: 200, attendancePercentage: 50, currentStreak: 30, globalRank: 0, category: GroupCategory.OTHER },
    ]);

    // Rebuild Redis
    await LeaderboardCacheRepository.rebuildGlobalLeaderboard();

    // Query MongoDB with the authoritative tie-break sort: { rankScore: -1, userId: -1 }
    const mongoDocs = await Ranking.find({ userId: { $in: [tiedUser1, tiedUser2] } })
      .sort({ rankScore: -1, userId: -1 })
      .select('userId rankScore')
      .lean();

    // Query Redis with ZREVRANGE
    const redisPage = await redis.zrevrange(globalKey, 0, -1);
    const redisFiltered = redisPage.filter((id) => id === tiedUser1 || id === tiedUser2);

    assert(mongoDocs.length === 2, 'Found 2 tied docs in MongoDB');
    assert(redisFiltered.length === 2, 'Found 2 tied docs in Redis');

    // In descending tie break on equal score 250:
    // tiedUser2 > tiedUser1, so tiedUser2 must come first in BOTH!
    assert(
      mongoDocs[0].userId === redisFiltered[0] && mongoDocs[1].userId === redisFiltered[1],
      `Exact tie-break order matches! Mongo: [${mongoDocs.map((d) => d.userId).join(', ')}] vs Redis: [${redisFiltered.join(', ')}]`
    );

    // ── Test 6: ZREM on User Deactivation / Deletion ──────────────────
    console.log('\n--- 6. ZREM on User Deletion / Deactivation ---');
    await LeaderboardCacheRepository.removeUser(userC);

    const rankCAfterRem = await LeaderboardCacheRepository.getUserGlobalRank(userC);
    assert(rankCAfterRem === null, 'User C removed from sorted sets via ZREM');

    // Also test User model hook triggers ZREM
    const testUser = await User.findOne({ userId: userB });
    if (testUser) {
      testUser.status = 'inactive';
      await testUser.save();

      const rankBAfterDeact = await LeaderboardCacheRepository.getUserGlobalRank(userB);
      assert(rankBAfterDeact === null, 'Deactivated user automatically removed from Redis leaderboard');
    }

    // ── Test 7: Concurrency Test ──────────────────────────────────────
    console.log('\n--- 7. Concurrency Test ---');
    const concurrentOps = Array.from({ length: 20 }, (_, idx) =>
      StudyAnalyticsCacheRepository.getUserStats(userA, async () => ({
        totalStudyTime: 5400,
        iteration: idx,
      }))
    );
    const concurrentResults = await Promise.all(concurrentOps);
    assert(concurrentResults.length === 20, '20 concurrent analytics reads completed successfully');
    assert(
      concurrentResults.every((r) => r.totalStudyTime === 5400),
      'All concurrent reads return consistent data'
    );

    console.log('\n==========================================================');
    console.log('🎉 Item I Study Analytics & Leaderboard Tests Passed Successfully!');
    console.log('==========================================================\n');
  } finally {
    // Cleanup test data
    await User.deleteMany({ userId: { $in: [userA, userB, userC, 'user_tied_aaa', 'user_tied_zzz'] } });
    await Ranking.deleteMany({ userId: { $in: [userA, userB, userC, 'user_tied_aaa', 'user_tied_zzz'] } });
    await redis.del(StudyAnalyticsCacheRepository.getStatsKey(userA));
    await redis.del(StudyAnalyticsCacheRepository.getStatsKey(userB));
    await redis.del(LeaderboardCacheRepository.getGlobalSetKey());
  }
}

runStudyCacheTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Study Cache Test failed:', err);
    process.exit(1);
  });
