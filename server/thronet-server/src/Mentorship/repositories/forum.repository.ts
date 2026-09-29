import mongoose from "mongoose";
import Forum, { IForum } from "../models/Forum";
import ForumReply, { IForumReply } from "../models/ForumReply";
import { CreateForumDTO, CreateForumReplyDTO, ForumListQuery } from "../interface/forum.types";
import { SortOrder } from "mongoose";

// Forum.author / ForumReply.author ab plain UUID string hai (ObjectId ref
// nahi), isliye Mongoose ka .populate() use nahi ho sakta. Ye helper
// manually User collection se un UUIDs ka basic profile fetch karke
// ek Map banata hai — jaisa community.service.ts mein top-mentors ke
// liye kiya tha.
async function attachAuthors<T extends { author: string }>(
  docs: T[]
): Promise<(T & { author: any })[]> {
  const authorIds = [...new Set(docs.map((d) => d.author))];
  if (authorIds.length === 0) return docs as any;

  const User = mongoose.model("User");
  const users = await User.find(
    { userId: { $in: authorIds } },
    "userId firstName lastName"   // ← sirf jo fields actually exist karte hain
  ).lean();

  const userMap = new Map(
    users.map((u: any) => [
      u.userId,
      { userId: u.userId, name: `${u.firstName} ${u.lastName || ""}`.trim() },
    ])
  );

  return docs.map((d) => {
    const plain = typeof (d as any).toObject === "function" ? (d as any).toObject() : d;
    return {
      ...plain,
      author: userMap.get(d.author) || null,
    };
  });
}

export class ForumRepository {
  async create(authorId: string, data: CreateForumDTO): Promise<IForum> {
    return Forum.create({ ...data, author: authorId, lastActivityAt: new Date() });
  }

  async findById(id: string) {
    const forum = await Forum.findById(id);
    if (!forum) return null;
    const [withAuthor] = await attachAuthors([forum]);
    return withAuthor;
  }

  async list(query: ForumListQuery) {
    const { category, sort = "recent", page = 1, limit = 20 } = query;
    const filter: Record<string, any> = {};
    if (category) filter.category = category;

    const sortStage: Record<string, SortOrder> =
      sort === "trending"
        ? { isPinned: -1, replyCount: -1, lastActivityAt: -1 }
        : { isPinned: -1, lastActivityAt: -1 };

    const [rawItems, total] = await Promise.all([
      Forum.find(filter)
        .sort(sortStage)
        .skip((page - 1) * limit)
        .limit(limit),
      Forum.countDocuments(filter),
    ]);

    const items = await attachAuthors(rawItems);

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
    const has = forum.upvotes.includes(userId);
    if (has) {
      forum.upvotes = forum.upvotes.filter((u) => u !== userId);
    } else {
      forum.upvotes.push(userId);
    }
    await forum.save();
    const [withAuthor] = await attachAuthors([forum]);
    return withAuthor;
  }

  async delete(id: string) {
    await ForumReply.deleteMany({ forum: id });
    return Forum.findByIdAndDelete(id);
  }

  async pin(id: string, isPinned: boolean) {
    const forum = await Forum.findByIdAndUpdate(id, { isPinned }, { new: true });
    if (!forum) return null;
    const [withAuthor] = await attachAuthors([forum]);
    return withAuthor;
  }

  async lock(id: string, isLocked: boolean) {
    const forum = await Forum.findByIdAndUpdate(id, { isLocked }, { new: true });
    if (!forum) return null;
    const [withAuthor] = await attachAuthors([forum]);
    return withAuthor;
  }

  async addReply(forumId: string, authorId: string, data: CreateForumReplyDTO): Promise<any> {
    const reply = await ForumReply.create({
      forum: forumId,
      author: authorId,
      content: data.content,
      mentions: data.mentions || [],
    });
    await this.incrementReplyCount(forumId);
    const [withAuthor] = await attachAuthors([reply]);
    return withAuthor;
  }

  async listReplies(forumId: string, page = 1, limit = 30) {
    const [rawItems, total] = await Promise.all([
      ForumReply.find({ forum: forumId })
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      ForumReply.countDocuments({ forum: forumId }),
    ]);
    const items = await attachAuthors(rawItems);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }
}

export default new ForumRepository();