export interface CreateForumDTO {
  topic: string;
  description?: string;
  category: "teaching-tips" | "pricing" | "tech-stack" | "general";
}

export interface CreateForumReplyDTO {
  content: string;
  mentions?: string[];
}

export interface ForumListQuery {
  category?: string;
  sort?: "recent" | "trending";
  page?: number;
  limit?: number;
}