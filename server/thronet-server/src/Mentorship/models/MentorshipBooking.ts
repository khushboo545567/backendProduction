import mongoose, { Schema, Document } from 'mongoose';
import { randomUUID } from 'crypto';

export interface MentorshipBookingDocument extends Document {
  bookingId: string;
  legacyBookingId?: string;
  sessionId: string;
  mentorId: string;
  menteeId: string;
  status: string;
  slotTime?: string;
  scheduledAt: Date;
  availabilityId?: string;
  bookedAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  pricing: { basePrice: number; platformFee: number; totalAmount: number; currency: string };
  payment: {
    status?: string;
    method?: string;
    transactionId?: string;
    paidAt?: Date;
    refundAmount?: number;
    refundedAt?: Date;
    refundReason?: string;
  };
  reminders: { m5: boolean; m15: boolean; m30: boolean; h1: boolean; h24: boolean };
  reschedule: {
    count: number;
    lastRescheduledAt?: Date;
    previousDates: Date[];
    rescheduledBy?: string;
    reason?: string;
  };
  cancellation?: {
    cancelledBy?: string;
    cancelledAt?: Date;
    reason?: string;
    refundEligible?: boolean;
  };
  completion?: {
    completedAt?: Date;
    actualDuration?: number;
    wasSuccessful?: boolean;
    followUpRequired?: boolean;
    followUpNotes?: string;
  };
  review?: {
    mentorReview?: string;
    menteeReview?: string;
    rating?: number;
    reviewedAt?: Date;
  };
}

const MentorshipBookingSchema = new Schema<MentorshipBookingDocument>(
  {
    bookingId: { type: String, required: true, unique: true, default: () => randomUUID() },
    // Purane sessionmentors.bookings[]._id (migration dobara chalane par duplicate nahi banega)
    legacyBookingId: { type: String, unique: true, sparse: true },
    sessionId: { type: String, required: true, index: true },
    mentorId: { type: String, required: true, index: true },
    menteeId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'rescheduled', 'in_progress', 'cancelled', 'completed', 'no_show', 'refunded'],
      default: 'pending',
      index: true,
    },
    slotTime: { type: String },
    scheduledAt: { type: Date, required: true, index: true },
    availabilityId: { type: String, index: true },
    bookedAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    endedAt: { type: Date },
    pricing: {
      basePrice: { type: Number, default: 0, min: 0 },
      platformFee: { type: Number, default: 0, min: 0 },
      totalAmount: { type: Number, default: 0, min: 0 },
      currency: { type: String, default: 'INR' },
    },
    payment: {
      status: { type: String },
      method: { type: String },
      transactionId: { type: String, index: true },
      paidAt: { type: Date },
      refundAmount: { type: Number, min: 0 },
      refundedAt: { type: Date },
      refundReason: { type: String },
    },
    reminders: {
      m5: { type: Boolean, default: false },
      m15: { type: Boolean, default: false },
      m30: { type: Boolean, default: false },
      h1: { type: Boolean, default: false },
      h24: { type: Boolean, default: false },
    },
    reschedule: {
      count: { type: Number, default: 0, min: 0 },
      lastRescheduledAt: { type: Date },
      previousDates: [Date],
      rescheduledBy: { type: String },
      reason: { type: String },
    },
    cancellation: {
      cancelledBy: { type: String },
      cancelledAt: { type: Date },
      reason: { type: String },
      refundEligible: { type: Boolean },
    },
    completion: {
      completedAt: { type: Date },
      actualDuration: { type: Number },
      wasSuccessful: { type: Boolean },
      followUpRequired: { type: Boolean },
      followUpNotes: { type: String },
    },
    review: {
      mentorReview: { type: String },
      menteeReview: { type: String },
      rating: { type: Number, min: 1, max: 5 },
      reviewedAt: { type: Date },
    },
  },
  { timestamps: true, collection: 'mentorship_bookings' }
);

MentorshipBookingSchema.index({ mentorId: 1, status: 1, scheduledAt: 1 });
MentorshipBookingSchema.index({ menteeId: 1, status: 1, scheduledAt: 1 });
MentorshipBookingSchema.index({ sessionId: 1, menteeId: 1 });
MentorshipBookingSchema.index({ status: 1, scheduledAt: 1 });

export default mongoose.model<MentorshipBookingDocument>('MentorshipBooking', MentorshipBookingSchema);