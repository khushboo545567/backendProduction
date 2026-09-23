import { Response, NextFunction } from 'express';
import { Domain } from '@/shared/constants/domains';
import { mentorService } from '@/shared/services/index.service';
import {
  CreateMentorInput,
  MentorFilters,
  MentorSortOptions,
  UpdateMentorInput,
} from '@/Mentorship/interface/mentor.types';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import { AuthRequest } from '@/shared/middlewares/auth.middleware';
import { TrustScoreService } from '@/Mentorship/services/trustScore.service';
import mentorRepository from '@/Mentorship/repositories/mentor.repository';
import { TrustScoreCalculator } from '../utils/trustScoreCalculator';
import MentorshipAnalytics from '@/Mentorship/models/mentorshipAnalytics';
import { User } from '@/auth/models';
import { Notification } from '@/Mentorship/models';
import notificationService, { NotificationType, NotificationChannel } from '../services/notification.service';

class MentorController {
  /**
   * @route   POST /api/v1/mentorship/mentors
   * @access  Private
   */
  async createProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, message: 'Profile picture is required' });
        return;
      }

      const input: CreateMentorInput = {
        userId: req.user!.id,
        companyId: req.body.companyId,
        title: req.body.title,
        bio: req.body.bio,
        tagline: req.body.tagline,
        domains: req.body.domains,
        skills: req.body.skills,
        languages: req.body.languages,
        experience: req.body.experience,
        pricing: req.body.pricing,
        availability: req.body.availability,
        socialProof: req.body.socialProof,
        preferences: req.body.preferences,
        profilePicFile: req.file,
      };

      const authToken = req.headers.authorization?.split(' ')[1];
      const mentor = await mentorService.createMentor(input, authToken);

      logger.info(`Mentor profile created: ${mentor._id}`);
      ResponseHandler.created(
        res,
        'Mentor profile created successfully. Your profile is pending approval.',
        mentor
      );
    } catch (error: any) {
      logger.error('Error creating mentor profile:', error);
      next(error);
    }
  }

  /**
   * @route   PUT /api/v1/mentorship/mentors/:id
   * @access  Private (mentor owner)
   */
  async updateProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;

      const updates: UpdateMentorInput = {
        title: req.body.title,
        bio: req.body.bio,
        tagline: req.body.tagline,
        domains: req.body.domains,
        skills: req.body.skills,
        languages: req.body.languages,
        experience: req.body.experience,
        pricing: req.body.pricing,
        availability: req.body.availability,
        socialProof: req.body.socialProof,
        preferences: req.body.preferences,
        status: req.body.status,
      };

      (Object.keys(updates) as (keyof UpdateMentorInput)[]).forEach((key) => {
        if (updates[key] === undefined) delete updates[key];
      });

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const profilePicFile = files?.['profilePic']?.[0];
      const bannerImageFile = files?.['bannerImage']?.[0];

      const authToken = req.headers.authorization?.split(' ')[1];
      const mentor = await mentorService.updateMentor(id, updates, req.user!.id, authToken, profilePicFile, bannerImageFile);

      logger.info(`Mentor profile updated: ${id}`);
      ResponseHandler.success(res, 'Mentor profile updated successfully', mentor);
    } catch (error: any) {
      logger.error('Error updating mentor profile:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/mentors/:id
   * @access  Public
   */
  async getProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const authToken = req.headers.authorization?.split(' ')[1];
      const mentor: any = await mentorService.getMentorById(id, authToken);

      MentorshipAnalytics.recordEvent('mentor_analytics', 'mentor', id, 'views').catch((err: any) =>
        logger.error('Failed to record mentor profile view:', err)
      );


      if (mentor && req.user?.id) {
        const savedBy: string[] = mentor.savedBy || [];
        mentor.isSavedByCurrentUser = savedBy.includes(req.user.id);
      }

      ResponseHandler.success(res, 'Mentor profile fetched successfully', mentor);
    } catch (error: any) {
      logger.error('Error fetching mentor profile:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/mentors/user/:userId
   * @access  Public
   */
  async getProfileByUserId(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const authToken = req.headers.authorization?.split(' ')[1];
      const mentor = await mentorService.getMentorByUserId(userId, authToken);

      // ✅ Profile Viewed in-app notification (fire-and-forget, non-blocking)
      try {
        let viewerId: string | undefined = req.user?.id || (req.user as any)?.userId;
        if (!viewerId && authToken) {
          try {
            const decoded = User.verifyToken(authToken) as any;
            viewerId = decoded?.userId || decoded?.id;
          } catch {
            // invalid or expired token -> viewer remains anonymous
          }
        }

        const mentorUserId = userId; // Directly from req.params.userId

        // Only notify if viewer is logged in and not the mentor themselves (self-view)
        if (mentorUserId && viewerId && viewerId !== mentorUserId) {
          (async () => {
            let viewerName = 'Someone';

try {
  const viewer = await User.findByUserId(viewerId);

  if (viewer) {
    viewerName =
      viewer.fullName ||
      viewer.email ||
      viewer.firstName ||
      'Someone';
  }
} catch (err) {
  logger.error('Failed to resolve profile viewer:', err);
}
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const alreadyNotified = await Notification.findOne({
              userId: mentorUserId,
              type: NotificationType.PROFILE_VIEWED,
              'data.viewerId': viewerId,
              createdAt: { $gte: twentyFourHoursAgo },
            }).lean();

            if (alreadyNotified) {
              logger.info(`Profile view notification deduped: mentor ${mentorUserId}, viewer ${viewerId}`);
              return;
            }

            try {
              await notificationService.sendNotification({
                userId: mentorUserId,
                type: NotificationType.PROFILE_VIEWED,
                channels: [NotificationChannel.IN_APP],
                priority: 'low',
                data: {
                  title: 'Profile Viewed',
                message: `${viewerName} viewed your profile.`,
                  viewerId,
                },
              });
              logger.info(`✅ Profile view notification sent to mentor ${mentorUserId}`);
            } catch (err: any) {
              logger.error('Failed to send profile view notification: ', err);
            }
          })().catch((err: any) =>
            logger.error('Failed to process profile view notification:', err)
          );
        }
      } catch (err: any) {
        logger.error('Error in profile view notification check:', err);
      }

      ResponseHandler.success(res, 'Mentor profile fetched successfully', mentor);
    } catch (error: any) {
      logger.error('Error fetching mentor profile by userId:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/mentors/me
   * @access  Private
   */
  async getMyProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const authToken = req.headers.authorization?.split(' ')[1];
      const mentor = await mentorService.getMentorByUserId(req.user!.id, authToken);

      ResponseHandler.success(res, 'Your mentor profile fetched successfully', mentor);
    } catch (error: any) {
      logger.error('Error fetching own mentor profile:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/me/trust-score
   * @access  Private
   */
  async getTrustScore(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const authToken = req.headers.authorization?.split(' ')[1];
      const mentor = await mentorService.getMentorByUserId(req.user!.id, authToken);

      if (!mentor) {
        res.status(404).json({ success: false, message: 'Mentor profile not found' });
        return;
      }

      let trustScore = mentor.trustScore;

      const isUncalculated =
        !trustScore ||
        Object.keys(trustScore).length === 0 ||
        (trustScore.overall === 0 && (!trustScore.metrics || trustScore.metrics.totalCompletedSessions === 0));

      if (isUncalculated) {
        const recalculatedScore = await TrustScoreService.recalculate(mentor.mentorId);

        if (recalculatedScore) {
          trustScore = recalculatedScore;
        } else {
          trustScore = TrustScoreCalculator.calculate({
            totalSessions: 0,
            completedSessions: 0,
            cancelledSessions: 0,
            averageRating: 0,
            totalReviews: 0,
            hasTitle: !!mentor.title,
            hasBio: !!mentor.bio && mentor.bio.length >= 50,
            hasDomains: Array.isArray(mentor.domains) && mentor.domains.length > 0,
            hasSkills: Array.isArray(mentor.skills) && mentor.skills.length > 0,
            isVerified: !!mentor.verification?.isVerified,
          });
        }
      }

      ResponseHandler.success(res, 'Trust Score fetched successfully', trustScore || null);
    } catch (error: any) {
      logger.error('Error fetching trust score:', error);
      next(error);
    }
  }

  /**
   * @route   DELETE /api/v1/mentorship/mentors/:id
   * @access  Private (mentor owner)
   */
  async deleteProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const authToken = req.headers.authorization?.split(' ')[1];
      await mentorService.deleteMentor(id, req.user!.id, authToken);

      logger.info(`Mentor profile deleted: ${id}`);
      ResponseHandler.success(res, 'Mentor profile deleted successfully');
    } catch (error: any) {
      logger.error('Error deleting mentor profile:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/mentors/:id/stats
   * @access  Public
   */
  async getMentorStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const stats = await mentorService.getMentorStats(id);

      ResponseHandler.success(res, 'Mentor stats fetched successfully', stats);
    } catch (error: any) {
      logger.error('Error fetching mentor stats:', error);
      next(error);
    }
  }

  /**
   * @route   GET /api/v1/mentorship/mentors
   * @access  Public
   */
  async getAllMentors(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;

      const filters: MentorFilters = {};

      if (req.query.domains) {
        const domainArray = Array.isArray(req.query.domains)
          ? (req.query.domains as string[])
          : [req.query.domains as string];
        filters.domains = domainArray as Domain[];
      }

      if (req.query.companyIds) {
        filters.companyIds = Array.isArray(req.query.companyIds)
          ? (req.query.companyIds as string[])
          : [req.query.companyIds as string];
      }

      if (req.query.minPrice) filters.minPrice = parseFloat(req.query.minPrice as string);
      if (req.query.maxPrice) filters.maxPrice = parseFloat(req.query.maxPrice as string);
      if (req.query.minRating) filters.minRating = parseFloat(req.query.minRating as string);
      if (req.query.minExperience) filters.minExperience = parseInt(req.query.minExperience as string);

      if (req.query.experienceLevel) {
        filters.experienceLevel = Array.isArray(req.query.experienceLevel)
          ? (req.query.experienceLevel as any[])
          : [req.query.experienceLevel as string];
      }

      if (req.query.languages) {
        filters.languages = Array.isArray(req.query.languages)
          ? (req.query.languages as string[])
          : [req.query.languages as string];
      }

      if (req.query.skills) {
        filters.skills = Array.isArray(req.query.skills)
          ? (req.query.skills as string[])
          : [req.query.skills as string];
      }

      if (req.query.featured !== undefined) {
        filters.featured = req.query.featured === 'true';
      }

      const sort: MentorSortOptions | undefined = req.query.sortBy
        ? {
            field: req.query.sortBy as any,
            order: (req.query.sortOrder as 'asc' | 'desc') || 'desc',
          }
        : undefined;

      const authToken = req.headers.authorization?.split(' ')[1];
      const result = await mentorService.getAllMentors(page, limit, filters, sort, authToken);

      ResponseHandler.paginated(
        res,
        'Mentors fetched successfully',
        result.mentors,
        result.page,
        result.limit,
        result.total
      );
    } catch (error: any) {
      logger.error('Error fetching mentors:', error);
      next(error);
    }
  }

  /**
   * @route   PATCH /api/v1/mentorship/mentors/:mentorId/approve
   * @access  Private (Admin only)
   */
  async approveMentor(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { mentorId } = req.params;
      const result = await mentorService.approveMentor(mentorId, req.user!.id);

      logger.info(`Mentor approved: ${mentorId} by admin: ${req.user!.id}`);
      ResponseHandler.success(
        res,
        'Mentor account has been successfully approved.',
        result
      );
    } catch (error: any) {
      logger.error('Error approving mentor:', error);
      next(error);
    }
  }

  /**
   * @route   PATCH /api/v1/mentorship/mentors/:id/save
   * @desc    Toggle saving/bookmarking a mentor for the current user
   * @access  Private
   */
  async toggleSaveMentor(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params; // mentorId
      const userId = req.user!.id;

      const result = await mentorRepository.toggleSavedBy(id, userId);
      if (!result) {
        res.status(404).json({ success: false, message: 'Mentor not found' });
        return;
      }

      logger.info(`Mentor ${id} ${result.saved ? 'saved' : 'unsaved'} by user: ${userId}`);
      ResponseHandler.success(
        res,
        result.saved ? 'Mentor saved successfully' : 'Mentor removed from saved list',
        { saved: result.saved }
      );
    } catch (error: any) {
      logger.error('Error toggling saved mentor:', error);
      next(error);
    }
  }

  /**
   * @route   POST /api/v1/mentorship/mentors/:id/report
   * @desc    Report a mentor profile
   * @access  Private
   *
   * ✅ FIX: pehle ye seedha `Mentor` model use karta tha jo is file mein
   * kabhi import hi nahi hua tha (compile error). Ab repository ke through
   * jaata hai — baaki controller methods (createProfile, updateProfile,
   * getMentorStats, etc.) bhi sab service/repository ke through hi jaate
   * hain, isliye ye consistent hai.
   */
  async reportMentor(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params; // mentorId
      const userId = req.user!.id;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

      if (!reason) {
        res.status(400).json({ success: false, message: 'Report reason is required' });
        return;
      }

      const updatedMentor = await mentorRepository.addReport(id, {
        reportedBy: userId,
        reason,
        status: 'pending',
        createdAt: new Date(),
      });

      if (!updatedMentor) {
        res.status(404).json({ success: false, message: 'Mentor not found' });
        return;
      }

      logger.info(`Mentor ${id} reported by user: ${userId}`);
      ResponseHandler.success(res, 'Report submitted. Our team will review it.');
    } catch (error: any) {
      logger.error('Error reporting mentor:', error);
      next(error);
    }
  }
}

export default new MentorController();