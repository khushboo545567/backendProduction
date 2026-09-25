import Forum, { IForum } from "../models/Forum";
import ForumReply, { IForumReply } from "../models/ForumReply";
import { CreateForumDTO, CreateForumReplyDTO, ForumListQuery } from "../interface/forum.types";
import { Types, SortOrder } from "mongoose";

export class ForumRepository {
  async create(authorId: string, data: CreateForumDTO): Promise<IForum> {
    return Forum.create({ ...data, author: authorId, lastActivityAt: new Date() });
  }

  async findById(id: string): Promise<IForum | null> {
    return Forum.findById(id).populate("author", "name avatar headline");
  }

  async list(query: ForumListQuery) {
    const { category, sort = "recent", page = 1, limit = 20 } = query;
    const filter: Record<string, any> = {};
    if (category) filter.category = category;

    const sortStage: Record<string, SortOrder> =
      sort === "trending"
        ? { isPinned: -1, replyCount: -1, lastActivityAt: -1 }
        : { isPinned: -1, lastActivityAt: -1 };

    const [items, total] = await Promise.all([
      Forum.find(filter)
        .sort(sortStage)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "name avatar headline"),
      Forum.countDocuments(filter),
    ]);

    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  async incrementReplyCount(forumId: string) {
    return Forum.findByIdAndUpdate(forumId, {
      $inc: { replyCount: 1 },
      $set: { lastActivityAt: new Date() },
    });
  }

  async toggleUpvote(forumId: string, userId: string) {
    const forum = await Forum.findById(forumId);
    if (!forum) return null;
    const uid = new Types.ObjectId(userId);
    const has = forum.upvotes.some((u) => u.equals(uid));
    if (has) {
      forum.upvotes = forum.upvotes.filter((u) => !u.equals(uid));
    } else {
      forum.upvotes.push(uid);
    }
    await forum.save();
    return forum;
  }

  async delete(id: string) {
    await ForumReply.deleteMany({ forum: id });
    return Forum.findByIdAndDelete(id);
  }

  async pin(id: string, isPinned: boolean) {
    return Forum.findByIdAndUpdate(id, { isPinned }, { new: true });
  }

  async lock(id: string, isLocked: boolean) {
    return Forum.findByIdAndUpdate(id, { isLocked }, { new: true });
  }

  async addReply(forumId: string, authorId: string, data: CreateForumReplyDTO): Promise<IForumReply> {
    const reply = await ForumReply.create({
      forum: forumId,
      author: authorId,
      content: data.content,
      mentions: data.mentions || [],
    });
    await this.incrementReplyCount(forumId);
    return reply;
  }

  async listReplies(forumId: string, page = 1, limit = 30) {
    const [items, total] = await Promise.all([
      ForumReply.find({ forum: forumId })
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "name avatar headline"),
      ForumReply.countDocuments({ forum: forumId }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }
}

export default new ForumRepository();