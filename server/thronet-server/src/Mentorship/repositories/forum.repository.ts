import mongoose from "mongoose";
import Forum, { IForum } from "../models/Forum";
import ForumReply, { IForumReply } from "../models/ForumReply";
import CommunityReport, { ICommunityReport, ReportReason, ReportTargetType } from "../models/CommunityReport";
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
    const { category, sort = "recent", page = 1, limit = 20, search } = query;
    const filter: Record<string, any> = {};
    if (category) filter.category = category;

    if (search && search.trim()) {
      const searchRegex = { $regex: search.trim(), $options: "i" };
      filter.$or = [
        { topic: searchRegex },
        { description: searchRegex },
      ];
    }

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

  async update(id: string, data: { topic?: string; description?: string }) {
    const forum = await Forum.findByIdAndUpdate(id, { $set: data }, { new: true });
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
      parentReplyId: data.parentReplyId || null,
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

  async findReplyById(replyId: string) {
    return ForumReply.findById(replyId);
  }

  async updateReply(replyId: string, content: string) {
    const updated = await ForumReply.findByIdAndUpdate(
      replyId,
      { $set: { content } },
      { new: true }
    );
    if (!updated) return null;
    const [withAuthor] = await attachAuthors([updated]);
    return withAuthor;
  }

  async deleteReply(replyId: string) {
    const reply = await ForumReply.findById(replyId);
    if (!reply) return null;

    // Cascade delete: delete this reply and any nested child replies
    const deleteResult = await ForumReply.deleteMany({
      $or: [{ _id: replyId }, { parentReplyId: replyId }],
    });
    const deletedCount = deleteResult.deletedCount || 1;

    if (reply.forum) {
      await Forum.findByIdAndUpdate(reply.forum, {
        $inc: { replyCount: -deletedCount },
      });
      await Forum.updateOne(
        { _id: reply.forum, replyCount: { $lt: 0 } },
        { $set: { replyCount: 0 } }
      );
    }

    return { deletedCount };
  }

  async findReport(reporterId: string, targetType: ReportTargetType, targetId: string) {
    return CommunityReport.findOne({ reporterId, targetType, targetId });
  }

  async createReport(data: {
    reporterId: string;
    targetType: ReportTargetType;
    targetId: string;
    forumId?: string;
    reason: ReportReason;
    note?: string;
  }): Promise<ICommunityReport> {
    return CommunityReport.create(data);
  }

  async listReports(query: {
    page?: number;
    limit?: number;
    status?: string;
    targetType?: string;
  }) {
    const { page = 1, limit = 20, status, targetType } = query;
    const filter: Record<string, any> = {};
    if (status) filter.status = status;
    if (targetType) filter.targetType = targetType;

    const [rawReports, total] = await Promise.all([
      CommunityReport.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CommunityReport.countDocuments(filter),
    ]);

    if (rawReports.length === 0) {
      return { items: [], total: 0, page, pages: 0 };
    }

    // 1. Attach reporter user info
    const reporterIds = [...new Set(rawReports.map((r) => r.reporterId))];
    const User = mongoose.model("User");
    const users = await User.find(
      { userId: { $in: reporterIds } },
      "userId firstName lastName email"
    ).lean();

    const userMap = new Map(
      users.map((u: any) => [
        u.userId,
        {
          userId: u.userId,
          name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Community Member",
          email: u.email,
        },
      ])
    );

    // 2. Fetch targets (Forums and ForumReplies) to provide preview
    const forumIds = [
      ...new Set(
        rawReports
          .filter((r) => r.targetType === "forum")
          .map((r) => r.targetId)
          .concat(
            rawReports
              .filter((r) => r.targetType === "forumReply" && r.forumId)
              .map((r) => r.forumId!)
          )
      ),
    ];
    const replyIds = [
      ...new Set(
        rawReports
          .filter((r) => r.targetType === "forumReply")
          .map((r) => r.targetId)
      ),
    ];

    const [forums, replies] = await Promise.all([
      forumIds.length > 0 ? Forum.find({ _id: { $in: forumIds } }, "topic description category").lean() : [],
      replyIds.length > 0 ? ForumReply.find({ _id: { $in: replyIds } }, "content forum author").lean() : [],
    ]);

    const forumMap = new Map((forums as any[]).map((f: any) => [f._id.toString(), f]));
    const replyMap = new Map((replies as any[]).map((r: any) => [r._id.toString(), r]));

    const items = rawReports.map((report: any) => {
      const reporter = userMap.get(report.reporterId) || {
        userId: report.reporterId,
        name: "Unknown User",
      };

      let contentPreview: string | null = null;
      let threadTopic: string | null = null;

      if (report.targetType === "forum") {
        const f = forumMap.get(report.targetId);
        if (f) {
          threadTopic = f.topic;
          contentPreview = f.description || f.topic;
        } else {
          contentPreview = "[Deleted Thread]";
        }
      } else if (report.targetType === "forumReply") {
        const r = replyMap.get(report.targetId);
        if (r) {
          contentPreview = r.content;
        } else {
          contentPreview = "[Deleted Reply]";
        }
        if (report.forumId) {
          const parentF = forumMap.get(report.forumId);
          if (parentF) threadTopic = parentF.topic;
        }
      }

      return {
        ...report,
        reporter,
        contentPreview,
        threadTopic,
      };
    });

    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  async updateReportStatus(reportId: string, status: "resolved" | "dismissed") {
    return CommunityReport.findByIdAndUpdate(
      reportId,
      { $set: { status } },
      { new: true }
    );
  }
}

export default new ForumRepository();
