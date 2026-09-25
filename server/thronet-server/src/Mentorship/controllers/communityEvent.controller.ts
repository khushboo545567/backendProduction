import { Response, NextFunction } from 'express';
import { AuthRequest } from '@/shared/middlewares/auth.middleware';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import communityEventService from '@/Mentorship/services/communityEvent.service';
import {
  createCommunityEventSchema,
  updateCommunityEventSchema,
  communityEventListQuerySchema,
} from '@/Mentorship/validations/communityEvent.validator';

class CommunityEventController {
  async createEvent(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = createCommunityEventSchema.parse(req.body);
      const event = await communityEventService.createEvent(req.user!.id, data);
      logger.info(`Community event created: ${event._id}`);
      ResponseHandler.created(res, 'Community event created', event);
    } catch (error: any) {
      logger.error('Error creating community event:', error);
      next(error);
    }
  }

  async listEvents(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = communityEventListQuerySchema.parse(req.query);
      const result = await communityEventService.listEvents(query);
      ResponseHandler.success(res, 'Community events fetched', result);
    } catch (error: any) {
      logger.error('Error fetching community events:', error);
      next(error);
    }
  }

  async getEvent(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await communityEventService.getEvent(req.params.id);
      let isGoing = false;
      if (req.user?.id) {
        isGoing = await communityEventService.isUserGoing(req.params.id, req.user.id);
      }
      ResponseHandler.success(res, 'Community event fetched', { ...event.toObject(), isGoing });
    } catch (error: any) {
      logger.error('Error fetching community event:', error);
      next(error);
    }
  }

  async updateEvent(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = updateCommunityEventSchema.parse(req.body);
      const isAdmin = (req.user as any)?.role === 'admin';
      const event = await communityEventService.updateEvent(req.params.id, req.user!.id, isAdmin, data);
      ResponseHandler.success(res, 'Community event updated', event);
    } catch (error: any) {
      logger.error('Error updating community event:', error);
      next(error);
    }
  }

  async cancelEvent(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = (req.user as any)?.role === 'admin';
      const event = await communityEventService.cancelEvent(req.params.id, req.user!.id, isAdmin);
      ResponseHandler.success(res, 'Community event cancelled', event);
    } catch (error: any) {
      logger.error('Error cancelling community event:', error);
      next(error);
    }
  }

  async deleteEvent(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = (req.user as any)?.role === 'admin';
      await communityEventService.deleteEvent(req.params.id, req.user!.id, isAdmin);
      ResponseHandler.success(res, 'Community event deleted');
    } catch (error: any) {
      logger.error('Error deleting community event:', error);
      next(error);
    }
  }

  async rsvp(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { event, alreadyGoing } = await communityEventService.rsvp(req.params.id, req.user!.id);
      ResponseHandler.success(res, alreadyGoing ? "Already RSVP'd" : 'RSVP confirmed', event);
    } catch (error: any) {
      logger.error('Error processing RSVP:', error);
      next(error);
    }
  }

  async cancelRsvp(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await communityEventService.cancelRsvp(req.params.id, req.user!.id);
      ResponseHandler.success(res, 'RSVP cancelled', event);
    } catch (error: any) {
      logger.error('Error cancelling RSVP:', error);
      next(error);
    }
  }

  async listAttendees(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = req.query.page ? Number(req.query.page) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const result = await communityEventService.listAttendees(req.params.id, page, limit);
      ResponseHandler.success(res, 'Attendees fetched', result);
    } catch (error: any) {
      logger.error('Error fetching attendees:', error);
      next(error);
    }
  }
}

export default new CommunityEventController();
