import mongoose, { Schema, Document, Types } from "mongoose";

export interface IForum extends Document {
  topic: string;
  description?: string;
  category: "teaching-tips" | "pricing" | "tech-stack" | "general";
  author: Types.ObjectId;
  replyCount: number;
  upvotes: Types.ObjectId[];
  isPinned: boolean;
  isLocked: boolean;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ForumSchema = new Schema<IForum>(
  {
    topic: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    category: {
      type: String,
      enum: ["teaching-tips", "pricing", "tech-stack", "general"],
      default: "general",
    },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    replyCount: { type: Number, default: 0 },
    upvotes: [{ type: Schema.Types.ObjectId, ref: "User" }],
    isPinned: { type: Boolean, default: false },
    isLocked: { type: Boolean, default: false },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ForumSchema.index({ category: 1, lastActivityAt: -1 });
ForumSchema.index({ isPinned: -1, lastActivityAt: -1 });

export default mongoose.model<IForum>("Forum", ForumSchema);