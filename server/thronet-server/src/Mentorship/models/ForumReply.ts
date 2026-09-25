import mongoose, { Schema, Document, Types } from "mongoose";

export interface IForumReply extends Document {
  forum: Types.ObjectId;
  author: Types.ObjectId;
  content: string;
  mentions: Types.ObjectId[];
  upvotes: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const ForumReplySchema = new Schema<IForumReply>(
  {
    forum: { type: Schema.Types.ObjectId, ref: "Forum", required: true },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, trim: true, maxlength: 3000 },
    mentions: [{ type: Schema.Types.ObjectId, ref: "User" }],
    upvotes: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

ForumReplySchema.index({ forum: 1, createdAt: 1 });

export default mongoose.model<IForumReply>("ForumReply", ForumReplySchema);