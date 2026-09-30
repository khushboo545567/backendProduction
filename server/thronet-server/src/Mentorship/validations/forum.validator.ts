import { z } from "zod";

export const createForumSchema = z.object({
  topic: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  category: z.enum(["teaching-tips", "pricing", "tech-stack", "general"]),
});

export const createForumReplySchema = z.object({
  content: z.string().min(1).max(3000),
  mentions: z.array(z.string()).optional(),
  parentReplyId: z.string().optional().nullable(),
});

export const forumListQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  sort: z.enum(["recent", "trending"]).optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});


export const updateForumSchema = z.object({
  topic: z.string().min(3).max(200).optional(),
  description: z.string().max(2000).optional(),
}).refine((d) => d.topic !== undefined || d.description !== undefined, {
  message: 'At least one of topic or description must be provided',
});

export const updateForumReplySchema = z.object({
  content: z.string().min(1).max(3000),
});

export const reportContentSchema = z.object({
  reason: z.enum(['spam', 'harassment', 'inappropriate', 'other']),
  note: z.string().max(1000).optional(),
});

export const reportListQuerySchema = z.object({
  status: z.enum(['pending', 'resolved', 'dismissed']).optional(),
  targetType: z.enum(['forum', 'forumReply']).optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});

export const updateReportStatusSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
});

