import mongoose, { Document, Schema } from 'mongoose';

export type ReportTargetType = 'forum' | 'forumReply';
export type ReportReason = 'spam' | 'harassment' | 'inappropriate' | 'other';
export type ReportStatus = 'pending' | 'resolved' | 'dismissed';

export interface ICommunityReport extends Document {
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string; // forumId or replyId
  forumId?: string; // thread context if targetType is forumReply
  reason: ReportReason;
  note?: string;
  status: ReportStatus;
  createdAt: Date;
  updatedAt: Date;
}

const CommunityReportSchema = new Schema<ICommunityReport>(
  {
    reporterId: {
      type: String,
      required: true,
      index: true,
    },
    targetType: {
      type: String,
      enum: ['forum', 'forumReply'],
      required: true,
      index: true,
    },
    targetId: {
      type: String,
      required: true,
      index: true,
    },
    forumId: {
      type: String,
      index: true,
    },
    reason: {
      type: String,
      enum: ['spam', 'harassment', 'inappropriate', 'other'],
      required: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: ['pending', 'resolved', 'dismissed'],
      default: 'pending',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'CommunityReports',
  }
);

// Compound unique index to prevent duplicate reports by the same user on the same content
CommunityReportSchema.index(
  { reporterId: 1, targetType: 1, targetId: 1 },
  { unique: true }
);

export default mongoose.model<ICommunityReport>('CommunityReport', CommunityReportSchema);
