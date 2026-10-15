import mongoose, { Document, Schema } from 'mongoose';

export type ReviewReportStatus = 'pending' | 'kept' | 'deleted';
export type ReviewReportReason = 'spam' | 'inappropriate' | 'fake' | 'harassment' | 'other';

export const REVIEW_REPORT_REASONS: readonly ReviewReportReason[] = [
  'spam', 'inappropriate', 'fake', 'harassment', 'other',
] as const;

export interface IReviewReport extends Document {
  reportId: string;
  reviewId: string;
  mentorId: string;   // the Mentor profile id (Mentor.mentorId)
  reporterId: string; // the user who filed the report (req.user.userId, always the mentor's userId)
  reason: ReviewReportReason;
  note?: string;
  status: ReviewReportStatus;
  createdAt: Date;
  updatedAt: Date;
}

const ReviewReportSchema = new Schema<IReviewReport>(
  {
    reportId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    reviewId: {
      type: String,
      required: true,
      index: true,
    },
    mentorId: {
      type: String,
      required: true,
      index: true,
    },
    reporterId: {
      type: String,
      required: true,
      index: true,
    },
    reason: {
      type: String,
      required: true,
      enum: ['spam', 'inappropriate', 'fake', 'harassment', 'other'],
      trim: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 300,
    },
    status: {
      type: String,
      enum: ['pending', 'kept', 'deleted'],
      default: 'pending',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'ReviewReports',
  }
);

// Prevent duplicate reports: one report per (reviewer, review) pair.
// On first run this creates a new unique index. If the old non-unique index
// { reviewId: 1, mentorId: 1, status: 1 } exists in the DB it must be dropped
// manually: db.ReviewReports.dropIndex("reviewId_1_mentorId_1_status_1")
ReviewReportSchema.index(
  { reviewId: 1, reporterId: 1 },
  { unique: true }
);

export default mongoose.model<IReviewReport>('ReviewReport', ReviewReportSchema);
