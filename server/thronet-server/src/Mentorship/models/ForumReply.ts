import mongoose, { Schema, Document, Types } from "mongoose";

export interface IForumReply extends Document {
  forum: Types.ObjectId;
  author: string;
  content: string;
  mentions: string[];
  upvotes: string[];
  createdAt: Date;
  updatedAt: Date;
}

const ForumReplySchema = new Schema<IForumReply>(
  {
    forum: { type: Schema.Types.ObjectId, ref: "Forum", required: true },
    author: { type: String, required: true, index: true },
    content: { type: String, required: true, trim: true, maxlength: 3000 },
    mentions: [{ type: String }],
    upvotes: [{ type: String }],
  },
  { timestamps: true }
);

ForumReplySchema.index({ forum: 1, createdAt: 1 });

export default mongoose.model<IForumReply>("ForumReply", ForumReplySchema);