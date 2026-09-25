import forumRepository from "../repositories/forum.repository";
import { CreateForumDTO, CreateForumReplyDTO, ForumListQuery } from "../interface/forum.types";
import { AppError } from "../../shared/errors/app.error";

export class ForumService {
  async createForum(userId: string, data: CreateForumDTO) {
    return forumRepository.create(userId, data);
  }

  async getForum(id: string) {
    const forum = await forumRepository.findById(id);
    if (!forum) throw new AppError("Forum thread not found", 404);
    return forum;
  }

  async listForums(query: ForumListQuery) {
    return forumRepository.list(query);
  }

  async addReply(forumId: string, userId: string, data: CreateForumReplyDTO) {
    const forum = await forumRepository.findById(forumId);
    if (!forum) throw new AppError("Forum thread not found", 404);
    if (forum.isLocked) throw new AppError("This thread is locked", 403);
    return forumRepository.addReply(forumId, userId, data);
  }

  async listReplies(forumId: string, page?: number, limit?: number) {
    return forumRepository.listReplies(forumId, page, limit);
  }

  async toggleUpvote(forumId: string, userId: string) {
    const forum = await forumRepository.toggleUpvote(forumId, userId);
    if (!forum) throw new AppError("Forum thread not found", 404);
    return forum;
  }

  async deleteForum(id: string, requesterId: string, isAdmin: boolean) {
    const forum = await forumRepository.findById(id);
    if (!forum) throw new AppError("Forum thread not found", 404);
    if (!isAdmin && forum.author.toString() !== requesterId) {
      throw new AppError("Not authorized to delete this thread", 403);
    }
    return forumRepository.delete(id);
  }

  async pinForum(id: string, isPinned: boolean) {
    return forumRepository.pin(id, isPinned);
  }

  async lockForum(id: string, isLocked: boolean) {
    return forumRepository.lock(id, isLocked);
  }
}

export default new ForumService();