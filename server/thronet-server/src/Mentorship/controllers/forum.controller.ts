import { Response, NextFunction } from 'express';
import { AuthRequest } from '@/shared/middlewares/auth.middleware';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import forumService from '@/Mentorship/services/forum.service';
import {
  createForumSchema,
  createForumReplySchema,
  forumListQuerySchema,
} from '@/Mentorship/validations/forum.validator';

class ForumController {
  async createForum(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = createForumSchema.parse(req.body);
      const forum = await forumService.createForum(req.user!.id, data);
      ResponseHandler.created(res, 'Forum thread created', forum);
    } catch (error: any) {
      logger.error('Error creating forum thread:', error);
      next(error);
    }
  }

  async listForums(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = forumListQuerySchema.parse(req.query);
      const result = await forumService.listForums(query);
      ResponseHandler.success(res, 'Forums fetched', result);
    } catch (error: any) {
      logger.error('Error fetching forums:', error);
      next(error);
    }
  }

  async getForum(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const forum = await forumService.getForum(req.params.id);
      ResponseHandler.success(res, 'Forum thread fetched', forum);
    } catch (error: any) {
      logger.error('Error fetching forum thread:', error);
      next(error);
    }
  }

  async addReply(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = createForumReplySchema.parse(req.body);
      const reply = await forumService.addReply(req.params.id, req.user!.id, data);
      ResponseHandler.created(res, 'Reply added', reply);
    } catch (error: any) {
      logger.error('Error adding reply:', error);
      next(error);
    }
  }

  async listReplies(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = req.query.page ? Number(req.query.page) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const result = await forumService.listReplies(req.params.id, page, limit);
      ResponseHandler.success(res, 'Replies fetched', result);
    } catch (error: any) {
      logger.error('Error fetching replies:', error);
      next(error);
    }
  }

  async toggleUpvote(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const forum = await forumService.toggleUpvote(req.params.id, req.user!.id);
      ResponseHandler.success(res, 'Upvote toggled', forum);
    } catch (error: any) {
      logger.error('Error toggling upvote:', error);
      next(error);
    }
  }

  async deleteForum(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = (req.user as any)?.role === 'admin';
      await forumService.deleteForum(req.params.id, req.user!.id, isAdmin);
      ResponseHandler.success(res, 'Forum thread deleted');
    } catch (error: any) {
      logger.error('Error deleting forum thread:', error);
      next(error);
    }
  }

  async pinForum(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const forum = await forumService.pinForum(req.params.id, req.body.isPinned);
      ResponseHandler.success(res, 'Forum pin status updated', forum);
    } catch (error: any) {
      logger.error('Error pinning forum thread:', error);
      next(error);
    }
  }

  async lockForum(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const forum = await forumService.lockForum(req.params.id, req.body.isLocked);
      ResponseHandler.success(res, 'Forum lock status updated', forum);
    } catch (error: any) {
      logger.error('Error locking forum thread:', error);
      next(error);
    }
  }
}

export default new ForumController();