// src/controllers/waitlist.controller.ts
import { WaitlistStatus } from '../models/Waitlist';
import { waitlistService } from '../services';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import { Request, Response, NextFunction } from 'express';
/**
 * @desc    Join waitlist for a mentor
 * @route   POST /api/waitlist
 * @access  Private
 */
export const joinWaitlist = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const authToken = req.headers.authorization?.split(' ')[1];

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const {
      mentorId,
      serviceId,
      serviceTitle,
      preferredDates,
      preferredTimeSlots,
      sessionType,
      timezone,
      notes,
    } = req.body;

    const waitlistEntry = await waitlistService.joinWaitlist(
      {
        userId,
        mentorId,
        serviceId,
        serviceTitle,
        preferredDates,
        preferredTimeSlots,
        sessionType,
        timezone,
        notes,
      },
      authToken
    );

    ResponseHandler.created(res, 'Successfully joined waitlist', waitlistEntry);
  } catch(error : any) {
    logger.error('Error joining waitlist:', error);
    next(error);
  }
};

/**
 * @desc    Get user's position in waitlist
 * @route   GET /api/waitlist/position/:mentorId
 * @access  Private
 */
export const getUserPosition = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { mentorId } = req.params;

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const position = await waitlistService.getUserPosition(userId, mentorId);

    if (!position) {
      ResponseHandler.notFound(res, 'You are not in the waitlist for this mentor');
      return;
    }

    ResponseHandler.success(res, 'Position retrieved successfully', position);
  } catch(error : any) {
    logger.error('Error getting user position:', error);
    next(error);
  }
};

/**
 * @desc    Get all waitlist entries for logged-in user
 * @route   GET /api/waitlist/my-waitlists
 * @access  Private
 */
export const getUserWaitlists = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const waitlists = await waitlistService.getUserWaitlists(userId);

    ResponseHandler.success(res, 'User waitlists retrieved successfully', waitlists);
  } catch(error : any) {
    logger.error('Error getting user waitlists:', error);
    next(error);
  }
};

/**
 * @desc    Get waitlist for mentor (Mentor only)
 * @route   GET /api/waitlist/mentor/:mentorId
 * @access  Private (Mentor)
 */
export const getMentorWaitlist = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { mentorId } = req.params;
    const { status } = req.query;

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const waitlist = await waitlistService.getMentorWaitlist(
      mentorId,
      status as WaitlistStatus | undefined,
      userId
    );

    ResponseHandler.success(res, 'Mentor waitlist retrieved successfully', waitlist);
  } catch(error : any) {
    logger.error('Error getting mentor waitlist:', error);
    next(error);
  }
};

/**
 * @desc    Notify next person in waitlist (Mentor only)
 * @route   POST /api/waitlist/notify/:mentorId
 * @access  Private (Mentor)
 */
export const notifyNextInLine = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { mentorId } = req.params;
    const { serviceId } = req.body || {};
    const authToken = req.headers.authorization?.split(' ')[1];

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const notifiedEntry = await waitlistService.notifyNextInLine(mentorId, authToken, {
      requesterUserId: userId,
      serviceId,
    });

    if (!notifiedEntry) {
      ResponseHandler.notFound(res, 'No one in waitlist to notify');
      return;
    }

    ResponseHandler.success(res, 'Next person notified successfully', notifiedEntry);
  } catch(error : any) {
    logger.error('Error notifying next in line:', error);
    next(error);
  }
};

/**
 * @desc    Mark waitlist entry as booked
 * @route   PUT /api/waitlist/:waitlistId/book
 * @access  Private
 */
export const markAsBooked = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { waitlistId } = req.params;
    const userId = req.user?.id;
    const { sessionId } = req.body;

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const entry = await waitlistService.markAsBooked(waitlistId, sessionId, userId);

    ResponseHandler.success(res, 'Waitlist entry marked as booked', entry);
  } catch(error : any) {
    logger.error('Error marking as booked:', error);
    next(error);
  }
};

/**
 * @desc    Remove from waitlist
 * @route   DELETE /api/waitlist/:waitlistId
 * @access  Private
 */
export const removeFromWaitlist = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { waitlistId } = req.params;
    const userId = req.user?.id;
    const { reason } = req.body;

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    await waitlistService.removeFromWaitlist(waitlistId, userId, reason || 'User requested');

    ResponseHandler.success(res, 'Successfully removed from waitlist', null);
  } catch(error : any) {
    logger.error('Error removing from waitlist:', error);
    next(error);
  }
};

/**
 * @desc    Get waitlist statistics for mentor
 * @route   GET /api/waitlist/stats/:mentorId
 * @access  Private (Mentor)
 */
export const getWaitlistStats = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { mentorId } = req.params;

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const stats = await waitlistService.getWaitlistStats(mentorId, userId); 

    ResponseHandler.success(res, 'Waitlist statistics retrieved successfully', stats);
  } catch(error : any) {
    logger.error('Error getting waitlist stats:', error);
    next(error);
  }
};

/**
 * @desc    Mentor approves/offers a slot to a waitlist entry
 * @route   POST /api/waitlist/:waitlistId/offer
 * @access  Private (Mentor)
 */
export const offerWaitlistSlot = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { waitlistId } = req.params;

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const entry = await waitlistService.approveEntry(waitlistId, userId);
    ResponseHandler.success(res, 'Slot offered to waitlist entry successfully', entry);
  } catch (error: any) {
    logger.error('Error offering slot to waitlist entry:', error);
    next(error);
  }
};

export const approveWaitlistEntry = offerWaitlistSlot;

/**
 * @desc    Mentee claims an offered slot
 * @route   POST /api/waitlist/:waitlistId/claim
 * @access  Private
 */
export const claimWaitlistSlot = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { waitlistId } = req.params;
    const { sessionId } = req.body || {};

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const entry = await waitlistService.claimWaitlistSlot(waitlistId, userId, sessionId);
    ResponseHandler.success(res, 'Slot claimed successfully! Booking confirmed.', entry);
  } catch (error: any) {
    logger.error('Error claiming waitlist slot:', error);
    next(error);
  }
};

/**
 * @desc    Mentee declines an offered slot
 * @route   POST /api/waitlist/:waitlistId/decline
 * @access  Private
 */
export const declineWaitlistSlot = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { waitlistId } = req.params;
    const { reason } = req.body || {};

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const entry = await waitlistService.declineWaitlistSlot(waitlistId, userId, reason);
    ResponseHandler.success(res, 'Offer declined successfully.', entry);
  } catch (error: any) {
    logger.error('Error declining waitlist slot:', error);
    next(error);
  }
};

/**
 * @desc    Mentor updates priority of a waitlist entry (move up/down)
 * @route   PATCH /api/waitlist/:waitlistId/priority
 * @access  Private (Mentor)
 */
export const updateWaitlistPriority = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { waitlistId } = req.params;
    const { delta } = req.body || {};

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const entry = await waitlistService.updatePriority(waitlistId, userId, Number(delta) || 1);
    ResponseHandler.success(res, 'Priority updated successfully', entry);
  } catch (error: any) {
    logger.error('Error updating waitlist priority:', error);
    next(error);
  }
};

/**
 * @desc    Mentor removes an entry
 * @route   DELETE /api/waitlist/:waitlistId/remove
 * @access  Private (Mentor)
 */
export const removeWaitlistEntry = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { waitlistId } = req.params;
    const { reason } = req.body || {};

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    await waitlistService.removeFromWaitlist(waitlistId, userId, reason || 'Removed by mentor');
    ResponseHandler.success(res, 'Entry removed from waitlist successfully', null);
  } catch (error: any) {
    logger.error('Error removing waitlist entry:', error);
    next(error);
  }
};

/**
 * @desc    Mentor toggles auto-offer setting
 * @route   PATCH /api/waitlist/settings/auto-offer
 * @access  Private (Mentor)
 */
export const toggleAutoOffer = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { enabled } = req.body;

    if (!userId) {
      ResponseHandler.unauthorized(res);
      return;
    }

    const result = await waitlistService.toggleAutoOffer(userId, Boolean(enabled));
    ResponseHandler.success(res, 'Auto-offer setting updated', result);
  } catch (error: any) {
    logger.error('Error toggling auto offer setting:', error);
    next(error);
  }
};

