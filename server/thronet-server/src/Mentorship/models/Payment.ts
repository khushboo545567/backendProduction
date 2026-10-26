import mongoose, { Schema, Document } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

export enum PaymentPurpose {
  SESSION_BOOKING = 'session_booking',
  PACKAGE = 'package',
}

export enum GatewayPaymentStatus {
  CREATED = 'created',
  PAID = 'paid',
  FAILED = 'failed',
  PARTIALLY_REFUNDED = 'partially_refunded',
  REFUNDED = 'refunded',
}

export enum FulfillmentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  FULFILLED = 'fulfilled',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

export enum PayoutStatus {
  HELD = 'held',
  RELEASED = 'released',
  PAID = 'paid',
}

export interface IPaymentRefund {
  refundId: string;
  amount: number;
  status: string;
  reason?: string;
  createdAt: Date;
}

export interface IPayment extends Document {
  paymentId: string;
  userId: string;
  purpose: PaymentPurpose;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  amount: number;
  amountPaise: number;
  currency: string;
  pricing: {
    basePrice: number;
    platformFee: number;
    gst: number;
    totalAmount: number;
  };
  status: GatewayPaymentStatus;
  method?: string;
  failureReason?: string;
  paidAt?: Date;
  context: Record<string, any>;
  fulfillment: {
    status: FulfillmentStatus;
    startedAt?: Date;
    completedAt?: Date;
    sessionId?: string;
    bookingId?: string;
    packageId?: string;
    error?: string;
    attempts: number;
  };
  payout: {
    status: PayoutStatus;
    mentorAmount?: number;
    platformAmount?: number;
    releasedAt?: Date;
    releasedBy?: string;
    paidAt?: Date;
    paidBy?: string;
    reference?: string;
  };
  refunds: IPaymentRefund[];
  createdAt: Date;
  updatedAt: Date;
}

const RefundSchema = new Schema(
  {
    refundId: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, default: 'processing' },
    reason: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const MentorshipPaymentSchema = new Schema<IPayment>(
  {
    paymentId: { type: String, required: true, unique: true, default: () => uuidv4() },
    userId: { type: String, required: true, index: true },
    purpose: { type: String, enum: Object.values(PaymentPurpose), required: true },
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, unique: true, sparse: true },
    razorpaySignature: { type: String },
    amount: { type: Number, required: true, min: 0 },
    amountPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    pricing: {
      basePrice: { type: Number, default: 0 },
      platformFee: { type: Number, default: 0 },
      gst: { type: Number, default: 0 },
      totalAmount: { type: Number, default: 0 },
    },
    status: {
      type: String,
      enum: Object.values(GatewayPaymentStatus),
      default: GatewayPaymentStatus.CREATED,
      index: true,
    },
    method: { type: String },
    failureReason: { type: String },
    paidAt: { type: Date },
    context: { type: Schema.Types.Mixed, default: {} },
    fulfillment: {
      status: {
        type: String,
        enum: Object.values(FulfillmentStatus),
        default: FulfillmentStatus.PENDING,
      },
      startedAt: { type: Date },
      completedAt: { type: Date },
      sessionId: { type: String },
      bookingId: { type: String },
      packageId: { type: String },
      error: { type: String },
      attempts: { type: Number, default: 0 },
    },
    payout: {
      status: { type: String, enum: Object.values(PayoutStatus), default: PayoutStatus.HELD },
      mentorAmount: { type: Number },
      platformAmount: { type: Number },
      releasedAt: { type: Date },
      releasedBy: { type: String },
      paidAt: { type: Date },
      paidBy: { type: String },
      reference: { type: String },
    },
    refunds: { type: [RefundSchema], default: [] },
  },
  { timestamps: true, collection: 'mentorship_payments' }
);

MentorshipPaymentSchema.index({ userId: 1, createdAt: -1 });
MentorshipPaymentSchema.index({ status: 1, 'fulfillment.status': 1 });
MentorshipPaymentSchema.index({ purpose: 1, 'payout.status': 1 });
MentorshipPaymentSchema.index({ 'context.mentorId': 1 });

const MentorshipPayment = mongoose.model<IPayment>('MentorshipPayment', MentorshipPaymentSchema);

export default MentorshipPayment;