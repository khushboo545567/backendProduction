// controllers/streak.controller.ts

import { Request, Response } from 'express';
import { AuthRequest } from '@/shared/middlewares/auth.middleware';
import { asyncHandler } from '@/shared/utils/helpers.util';
import ResponseUtil from '@/shared/response.util';
import {
  getUserStreak,
  getStreakStats,
  getStreakLeaderboard,
  getGroupStreakLeaderboard,
  updateStreakAfterActivity,
} from '../services/streak.service';
import streakRepository from '../repositories/streak.repository';
import groupMemberRepository from '../repositories/groupMember.repository';

const MILESTONES = [7, 14, 30, 60, 90, 100, 180, 365];

export const getCurrentStreak = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as AuthRequest).user?.id;
  const streak = await getUserStreak(userId!);

  const nextMilestone = MILESTONES.find(m => m > streak.currentStreak);

  return ResponseUtil.success(res, {
    currentStreak: streak.currentStreak,
    startDate: streak.currentStreakStartDate,
    lastActivityDate: streak.lastActivityDate,
    isActive: streak.isActive,
    daysUntilMilestone: nextMilestone ? nextMilestone - streak.currentStreak : null,
    nextMilestone: nextMilestone || null,
  }, 'Current streak retrieved successfully');
});

export const getLongestStreak = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as AuthRequest).user?.id;
  const streak = await getUserStreak(userId!);

  return ResponseUtil.success(res, {
    longestStreak: streak.longestStreak,
    startDate: streak.longestStreakStartDate,
    endDate: streak.longestStreakEndDate,
    isCurrent: streak.currentStreak === streak.longestStreak && streak.currentStreak > 0,
  }, 'Longest streak retrieved successfully');
});

export const getStreakHistory = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as AuthRequest).user?.id;
  const [streak, stats] = await Promise.all([
    getUserStreak(userId!),
    getStreakStats(userId!),
  ]);

  const nextMilestone = MILESTONES.find(m => m > streak.currentStreak);

  return ResponseUtil.success(res, {
    currentStreak: {
      currentStreak: streak.currentStreak,
      startDate: streak.currentStreakStartDate,
      lastActivityDate: streak.lastActivityDate,
      isActive: streak.isActive,
      daysUntilMilestone: nextMilestone ? nextMilestone - streak.currentStreak : null,
      nextMilestone: nextMilestone || null,
    },
    longestStreak: {
      longestStreak: streak.longestStreak,
      startDate: streak.longestStreakStartDate,
      endDate: streak.longestStreakEndDate,
      isCurrent: streak.currentStreak === streak.longestStreak && streak.currentStreak > 0,
    },
    totalStreakBreaks: streak.streakBreaks,
    totalActiveDays: stats.totalActiveDays,
    averageStreakLength: stats.averageStreakLength,
    milestones: streak.milestones.map(m => ({
      days: m.days,
      achievedAt: m.achievedAt,
      title: `${m.days} Day Streak`,
      description: `Maintained ${m.days} consecutive days of activity`,
    })),
  }, 'Streak history retrieved successfully');
});

export const getGlobalLeaderboard = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as AuthRequest).user?.id;
  const limit = Math.min(Number(req.query.limit || 100), 100);

  const [leaderboard, myRank, myStreak, totalUsers] = await Promise.all([
    getStreakLeaderboard(limit),
    streakRepository.getUserRank(userId!),
    getUserStreak(userId!),
    streakRepository.countActiveStreaks(),
  ]);

  const topUsers = leaderboard.map((entry: any, index: number) => ({
    userId: entry.user.id || entry.user,
    userName: entry.user.name,
    userAvatar: entry.user.avatar,
    currentStreak: entry.currentStreak,
    longestStreak: entry.longestStreak,
    rank: index + 1,
    isCurrentUser: (entry.user.id || entry.user) === userId,
  }));

  return ResponseUtil.success(res, {
    topUsers,
    myRank: myRank || null,
    myStreak: myStreak.currentStreak,
    totalUsers,
    lastUpdated: new Date().toISOString(),
  }, 'Streak leaderboard retrieved successfully');
});

export const getGroupLeaderboard = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as AuthRequest).user?.id;
  const { groupId } = req.params;
  const limit = Math.min(Number(req.query.limit || 50), 50);

  const members = await groupMemberRepository.findByGroupId(groupId);
  const userIds = members.map((m: any) => m.userId);

  const leaderboard = await getGroupStreakLeaderboard(userIds, limit);

  const topUsers = leaderboard.map((entry: any, index: number) => ({
    userId: entry.user.id || entry.user,
    userName: entry.user.name,
    userAvatar: entry.user.avatar,
    currentStreak: entry.currentStreak,
    longestStreak: entry.longestStreak,
    rank: index + 1,
    isCurrentUser: (entry.user.id || entry.user) === userId,
  }));

  const myRank = topUsers.findIndex(u => u.isCurrentUser) + 1;

  return ResponseUtil.success(res, {
    groupId,
    leaderboard: topUsers,
    myRank: myRank || null,
    totalMembers: userIds.length,
  }, 'Group streak leaderboard retrieved successfully');
});

export const manualUpdateStreak = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as AuthRequest).user?.id;
  const streak = await updateStreakAfterActivity(userId!);

  return ResponseUtil.success(res, {
    currentStreak: streak.currentStreak,
    lastActivityDate: streak.lastActivityDate,
    isActive: streak.isActive,
  }, 'Streak updated successfully');
});

/**
 * ✅ NEW — Get any user's PUBLIC streak stats (for profile page — owner or visitor).
 * Sirf public-safe fields deta hai — koi breakdown/consistencyRate leak nahi hota.
 */
export const getPublicStreak = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const stats = await getStreakStats(userId);

  return ResponseUtil.success(res, {
    currentStreak: stats.currentStreak,
    longestStreak: stats.longestStreak,
    isActive: stats.isActive,
    milestones: stats.milestones,
  }, 'Public streak retrieved successfully');
});

export default {
  getCurrentStreak,
  getLongestStreak,
  getStreakHistory,
  getGlobalLeaderboard,
  getGroupLeaderboard,
  manualUpdateStreak,
  getPublicStreak,
};