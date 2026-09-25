import { z } from "zod";

export const createForumSchema = z.object({
  topic: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  category: z.enum(["teaching-tips", "pricing", "tech-stack", "general"]),
});

export const createForumReplySchema = z.object({
  content: z.string().min(1).max(3000),
  mentions: z.array(z.string()).optional(),
});

export const forumListQuerySchema = z.object({
  category: z.string().optional(),
  sort: z.enum(["recent", "trending"]).optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});