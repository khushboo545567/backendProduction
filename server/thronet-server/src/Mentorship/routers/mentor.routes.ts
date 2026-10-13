import { NextFunction, Request, Response, Router } from 'express';
import { mentorController } from '@/shared/controllers/index.controllers';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import { validate } from '@/shared/middlewares/validation.middleware';
import MentorValidator from '../validations/mentor.validator';
import upload, { uploadSingle, uploadFields } from '@/shared/upload/upload';

const router = Router();

// ye middleware multer ke baad lagao
const parseFormDataFields = (req: Request, res: Response, next: NextFunction): void => {
  const fieldsToParse = ['domains', 'skills', 'languages', 'experience', 'pricing', 'availability', 'socialProof', 'preferences'];

  for (const field of fieldsToParse) {
    const body = req.body as Record<string, any>; // ✅ yeh line add karo
    if (body[field] && typeof body[field] === 'string') {
      try {
        body[field] = JSON.parse(body[field]);
      } catch (e) {
        // ignore
      }
    }
  }
  next();
};


/**
 * @route   POST /api/mentors
 * @desc    Create a new mentor profile
 * @access  Private
 */
router.post(
  '/create',
  AuthMiddleware.authenticate as any,
  uploadSingle('profilePic'),
  parseFormDataFields as any,
  validate(MentorValidator.createMentor()),
  mentorController.createProfile as any
);

// /**
//  * @route   GET /api/mentors/me
//  * @desc    Get current user's mentor profile
//  * @access  Private
//  */
router.get(
  '/me',
  AuthMiddleware.authenticate as any,
  mentorController.getMyProfile as any
);

/**
 * @route   GET /api/mentors/me/trust-score
 * @desc    Get current user's mentor trust score
 * @access  Private
 */
router.get(
  '/me/trust-score',
  AuthMiddleware.authenticate as any,
  mentorController.getTrustScore as any 
);

/**
 * @route   GET /api/v1/mentorship/mentors/me/roles
 * @desc    Returns the logged-in user’s workspace role statuses in a single call.
 * @access  Private
 */
router.get(
  '/me/roles',
  AuthMiddleware.authenticate as any,
  mentorController.getMyRoles as any
);

// /**
//  * @route   GET /api/mentors
//  * @desc    Get all mentors with filters and pagination
//  * @access  Public
//  */
router.get(
  '/all',
  validate(MentorValidator.getPagination()),
  mentorController.getAllMentors
);

/**
 * @route   GET /api/v1/mentorship/mentors/:id/dashboard
 * @desc    Get unified real mentor dashboard data (stats, profile, upcoming sessions)
 * @access  Private (mentor owner with active status only)
 */
const mentorOwnershipGuard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const Mentor = (await import('../models/Mentor')).default;
    const { MentorStatus } = await import('../interface/mentor.types') as any;
    const { id } = req.params;
    const authReq = req as any;
    const userId = authReq.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    const doc = await Mentor.findOne({ $or: [{ mentorId: id }, { userId: id }] }).select('userId status').lean();
    if (!doc) {
      res.status(404).json({ success: false, message: 'Mentor profile not found' });
      return;
    }
    if ((doc as any).userId !== userId) {
      res.status(403).json({ success: false, message: 'Access denied: not your mentor profile' });
      return;
    }
    if ((doc as any).status !== MentorStatus.ACTIVE) {
      res.status(403).json({ success: false, message: 'Mentor profile is not active' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
};

router.get(
  '/:id/dashboard',
  AuthMiddleware.authenticate as any,
  mentorOwnershipGuard as any,
  mentorController.getMentorDashboard as any
);

/**
 * @route   GET /api/mentors/:id
 * @desc    Get mentor profile by ID
 * @access  Public
 */
router.get(
  '/:id',
  validate(MentorValidator.getMentorById()),
  mentorController.getProfile
);

// /**
//  * @route   GET /api/mentors/user/:userId
//  * @desc    Get mentor profile by user ID
//  * @access  Public
//  */
router.get(
  '/user/:userId',
  mentorController.getProfileByUserId
);

/**
 * @route   GET /api/mentors/:id/stats
 * @desc    Get mentor statistics
 * @access  Public
 */
router.get(
  '/:id/stats',
  validate(MentorValidator.getMentorStats()),
  mentorController.getMentorStats
);

/**
 * @route   PUT /api/mentors/:id
 * @desc    Update mentor profile
 * @access  Private (mentor owner only)
 */
router.put(
  '/:id',
  AuthMiddleware.authenticate as any,
  uploadFields([{ name: 'profilePic', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]),
  parseFormDataFields as any,
  validate(MentorValidator.updateMentor()),
  mentorController.updateProfile as any
);

/**
 * @route   DELETE /api/mentors/:id/profile-photo
 * @desc    Remove mentor profile photo
 * @access  Private (mentor owner only)
 */
router.delete(
  '/:id/profile-photo',
  AuthMiddleware.authenticate as any,
  mentorController.removeProfilePhoto as any
);

/**
 * @route   DELETE /api/mentors/:id
 * @desc    Delete mentor profile (soft delete)
 * @access  Private (mentor owner only)
 */
router.delete(
  '/:id',
  AuthMiddleware.authenticate as any,
  validate(MentorValidator.deleteMentor()),
  mentorController.deleteProfile as any
);

/**
 * @route   PATCH /api/mentors/:mentorId/approve
 * @desc    Admin: Approve mentor account (pending → active)
 * @access  Private (Admin only)
 */
router.patch(
  '/:mentorId/approve',
  AuthMiddleware.authenticate as any,
  AuthMiddleware.authorize('admin') as any,
  mentorController.approveMentor as any
);

/**
 * ⭐ NEW
 * @route   PATCH /api/mentors/:id/save
 * @desc    Toggle saving/bookmarking a mentor for the current user
 * @access  Private
 */
router.patch(
  '/:id/save',
  AuthMiddleware.authenticate as any,
  mentorController.toggleSaveMentor as any
);

/**
 * ⭐ NEW
 * @route   POST /api/mentors/:id/report
 * @desc    Report a mentor profile
 * @access  Private
 */
router.post(
  '/:id/report',
  AuthMiddleware.authenticate as any,
  mentorController.reportMentor as any
);

export default router;