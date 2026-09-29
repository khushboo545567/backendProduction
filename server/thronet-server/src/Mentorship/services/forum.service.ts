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
    const authorId = typeof forum.author === 'object' && forum.author !== null
      ? (forum.author as any).userId || String(forum.author)
      : String(forum.author);
    if (!isAdmin && authorId !== requesterId) {
      throw new AppError("Not authorized to delete this thread", 403);
    }
    return forumRepository.delete(id);
  }

  async pinForum(id: string, requesterId: string, isAdmin: boolean, isPinned: boolean) {
    const forum = await forumRepository.findById(id);
    if (!forum) throw new AppError("Forum thread not found", 404);
    const authorId = typeof forum.author === 'object' && forum.author !== null
      ? (forum.author as any).userId || String(forum.author)
      : String(forum.author);
    if (!isAdmin && authorId !== requesterId) {
      throw new AppError("Not authorized to pin this thread", 403);
    }
    return forumRepository.pin(id, isPinned);
  }

  async lockForum(id: string, requesterId: string, isAdmin: boolean, isLocked: boolean) {
    const forum = await forumRepository.findById(id);
    if (!forum) throw new AppError("Forum thread not found", 404);
    const authorId = typeof forum.author === 'object' && forum.author !== null
      ? (forum.author as any).userId || String(forum.author)
      : String(forum.author);
    if (!isAdmin && authorId !== requesterId) {
      throw new AppError("Not authorized to lock this thread", 403);
    }
    return forumRepository.lock(id, isLocked);
  }
}

export default new ForumService();