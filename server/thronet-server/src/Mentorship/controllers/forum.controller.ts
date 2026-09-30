import { Response, NextFunction } from 'express';
import { AuthRequest } from '@/shared/middlewares/auth.middleware';
import { logger } from '@/shared/logger.util';
import ResponseHandler from '@/shared/utils/mentorship/responseHandler';
import forumService from '@/Mentorship/services/forum.service';
import {
  createForumSchema,
  createForumReplySchema,
  forumListQuerySchema,
  updateForumSchema,
  updateForumReplySchema,
  reportContentSchema,
  reportListQuerySchema,
  updateReportStatusSchema,
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

  async updateForum(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = updateForumSchema.parse(req.body);
      const isAdmin = (req.user as any)?.role === 'admin';
      const forum = await forumService.updateForum(req.params.id, req.user!.id, isAdmin, data);
      ResponseHandler.success(res, 'Forum thread updated', forum);
    } catch (error: any) {
      logger.error('Error updating forum thread:', error);
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
      const isAdmin = (req.user as any)?.role === 'admin';
      const forum = await forumService.pinForum(req.params.id, req.user!.id, isAdmin, req.body.isPinned);
      ResponseHandler.success(res, 'Forum pin status updated', forum);
    } catch (error: any) {
      logger.error('Error pinning forum thread:', error);
      next(error);
    }
  }

  async lockForum(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = (req.user as any)?.role === 'admin';
      const forum = await forumService.lockForum(req.params.id, req.user!.id, isAdmin, req.body.isLocked);
      ResponseHandler.success(res, 'Forum lock status updated', forum);
    } catch (error: any) {
      logger.error('Error locking forum thread:', error);
      next(error);
    }
  }

  async updateReply(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = updateForumReplySchema.parse(req.body);
      const isAdmin = (req.user as any)?.role === 'admin';
      const reply = await forumService.updateReply(req.params.replyId, req.user!.id, isAdmin, data.content);
      ResponseHandler.success(res, 'Reply updated', reply);
    } catch (error: any) {
      logger.error('Error updating reply:', error);
      next(error);
    }
  }

  async deleteReply(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = (req.user as any)?.role === 'admin';
      await forumService.deleteReply(req.params.replyId, req.user!.id, isAdmin);
      ResponseHandler.success(res, 'Reply deleted');
    } catch (error: any) {
      logger.error('Error deleting reply:', error);
      next(error);
    }
  }

  async reportForum(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = reportContentSchema.parse(req.body);
      const report = await forumService.reportForum(
        req.params.id,
        req.user!.id,
        data.reason,
        data.note
      );
      ResponseHandler.created(res, 'Report submitted successfully. Our team will review it.', report);
    } catch (error: any) {
      logger.error('Error reporting forum thread:', error);
      next(error);
    }
  }

  async reportReply(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = reportContentSchema.parse(req.body);
      const report = await forumService.reportReply(
        req.params.id,
        req.params.replyId,
        req.user!.id,
        data.reason,
        data.note
      );
      ResponseHandler.created(res, 'Report submitted successfully. Our team will review it.', report);
    } catch (error: any) {
      logger.error('Error reporting reply:', error);
      next(error);
    }
  }

  async listReports(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = (req.user as any)?.role === 'admin';
      if (!isAdmin) {
        ResponseHandler.forbidden(res, 'Admin access required');
        return;
      }
      const query = reportListQuerySchema.parse(req.query);
      const result = await forumService.listReports(query as any);
      ResponseHandler.success(res, 'Community reports retrieved successfully', result);
    } catch (error: any) {
      logger.error('Error listing community reports:', error);
      next(error);
    }
  }

  async updateReportStatus(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = (req.user as any)?.role === 'admin';
      if (!isAdmin) {
        ResponseHandler.forbidden(res, 'Admin access required');
        return;
      }
      const { status } = updateReportStatusSchema.parse(req.body);
      const updated = await forumService.updateReportStatus(req.params.reportId, status);
      ResponseHandler.success(res, 'Report status updated successfully', updated);
    } catch (error: any) {
      logger.error('Error updating report status:', error);
      next(error);
    }
  }
}

export default new ForumController();
