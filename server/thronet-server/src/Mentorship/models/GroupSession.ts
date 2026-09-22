// src/Mentorship/models/GroupSession.model.ts
import mongoose, { Schema, Document } from 'mongoose';
import { PaymentMethod } from '@/Mentorship/interface/session.types';

export interface IParticipant {
  menteeId: string;
  registeredAt: Date;
  paymentStatus: 'pending' | 'completed' | 'failed' | 'refunded';
  transactionId?: string;
  paidAt?: Date;
  attendanceStatus: 'registered' | 'attended' | 'absent' | 'cancelled';
  // ✅ NEW: drives the Join Group → Mentor Approval flow.
  // 'pending'   -> mentee has requested to join, awaiting mentor action
  // 'accepted'  -> mentor approved; this participant now counts toward
  //                currentParticipants / maxParticipants and receives
  //                session-start notifications
  // 'rejected'  -> mentor declined; participant does NOT count toward
  //                capacity and cannot join the live session
  requestStatus: 'pending' | 'accepted' | 'rejected';
  respondedAt?: Date;
  certificate?: {
    issued: boolean;
    issuedAt?: Date;
    certificateUrl?: string;
  };
}

export interface IGroupSession {
  _id: string;
  sessionId: string; // New field for external reference
  mentorId: string;
  title: string;
  description: string;
  thumbnailImage?: string;
  topic: string;
  category?: string;
  scheduledAt: Date;
  duration: number;
  timezone: string;
  status: 'draft' | 'open' | 'full' | 'in_progress' | 'completed' | 'cancelled' | 'rescheduled';
  maxParticipants: number;
  minParticipants: number;
  currentParticipants: number;
  participants: IParticipant[];
  pricing: {
    pricePerPerson: number;
    currency: string;
    totalRevenue: number;
  };
  payment: {
    method: string;
  };
  settings: {
    followUp: {
      allowed: boolean;
      periodDays: number;
    };
    bufferTimeMinutes: number;
  };
  meeting: {
    platform: 'zoom' | 'google_meet' | 'daily_co' | 'custom';
    meetingUrl?: string;
    meetingId?: string;
    passcode?: string;
    recordingUrl?: string;
  };
  resources: string[];
  agenda?: string;
  outcomes?: string[];
  chat?: {
    enabled: boolean;
    expiresAt?: Date;
    messageCount: number;
  };
  feedback?: {
    averageRating: number;
    totalFeedbacks: number;
    comments: Array<{
      menteeId: string;
      rating: number;
      comment: string;
      submittedAt: Date;
    }>;
  };
  cancellation?: {
    cancelledAt: Date;
    reason: string;
    refundsProcessed: boolean;
  };
  completion?: {
    completedAt: Date;
    actualDuration: number;
    attendanceCount: number;
    certificatesIssued: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupSessionDocument extends Omit<IGroupSession, '_id'>, Document {
  id?: string;
  isFull: boolean;
  hasMinParticipants: boolean;
  spotsRemaining: number;
  canStart: boolean;
  addParticipant(menteeId: string, transactionId?: string): Promise<GroupSessionDocument>;
  removeParticipant(menteeId: string): Promise<GroupSessionDocument>;
  markAttendance(menteeId: string, attended: boolean): Promise<GroupSessionDocument>;
  // ✅ NEW
  acceptParticipant(menteeId: string): Promise<GroupSessionDocument>;
  rejectParticipant(menteeId: string): Promise<GroupSessionDocument>;
  startSession(): Promise<GroupSessionDocument>;
  completeSession(actualDuration?: number): Promise<GroupSessionDocument>;
  cancelSession(reason: string): Promise<GroupSessionDocument>;
  addFeedback(menteeId: string, rating: number, comment?: string): Promise<GroupSessionDocument>;
  issueCertificate(menteeId: string, certificateUrl: string): Promise<GroupSessionDocument>;
}

const ParticipantSchema = new Schema<IParticipant>(
  {
    menteeId: { type: String, required: true },
    registeredAt: { type: Date, default: Date.now },
    paymentStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
    },
    transactionId: { type: String },
    paidAt: { type: Date },
    attendanceStatus: {
      type: String,
      enum: ['registered', 'attended', 'absent', 'cancelled'],
      default: 'registered',
    },
    // ✅ NEW
    requestStatus: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending',
      index: true,
    },
    respondedAt: { type: Date },
    certificate: {
      issued: { type: Boolean, default: false },
      issuedAt: { type: Date },
      certificateUrl: { type: String },
    },
  },
  { _id: false }
);

const GroupSessionSchema = new Schema<GroupSessionDocument>(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    mentorId: {
      type: String,
      required: [true, 'Mentor ID is required'],
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },
    thumbnailImage: {
      type: String,
      trim: true,
    },
    topic: {
      type: String,
      required: [true, 'Topic is required'],
      trim: true,
    },
    category: {
      type: String,
      trim: true,
    },
    scheduledAt: {
      type: Date,
      required: [true, 'Scheduled time is required'],
      index: true,
    },
    duration: {
      type: Number,
      required: [true, 'Duration is required'],
      min: [30, 'Duration must be at least 30 minutes'],
      max: [180, 'Duration cannot exceed 180 minutes'],
    },
    timezone: {
      type: String,
      required: [true, 'Timezone is required'],
      default: 'UTC',
    },
    status: {
      type: String,
      enum: ['draft', 'open', 'full', 'in_progress', 'completed', 'cancelled', 'rescheduled'],
      default: 'draft',
      index: true,
    },
    maxParticipants: {
      type: Number,
      required: [true, 'Max participants is required'],
      min: [3, 'At least 3 participants required'],
      max: [50, 'Cannot exceed 50 participants'],
    },
    minParticipants: {
      type: Number,
      required: [true, 'Min participants is required'],
      min: [1, 'At least 1 participant required'],
    },
    currentParticipants: {
      type: Number,
      default: 0,
      min: 0,
    },
    participants: [ParticipantSchema],
    pricing: {
      pricePerPerson: {
        type: Number,
        required: [true, 'Price per person is required'],
        min: [0, 'Price cannot be negative'],
      },
      currency: { type: String, default: 'INR' },
      totalRevenue: { type: Number, default: 0, min: 0 },
    },
    payment: {
      method: {
        type: String,
        enum: Object.values(PaymentMethod),
        required: true,
      },
    },
    settings: {
      followUp: {
        allowed: { type: Boolean, default: false },
        periodDays: { type: Number, default: 0, min: 0, max: 30 },
      },
      bufferTimeMinutes: { type: Number, default: 0, min: 0, max: 60 },
    },
    meeting: {
      platform: {
        type: String,
        enum: ['zoom', 'google_meet', 'daily_co', 'custom'],
      },
      meetingUrl: { type: String },
      meetingId: { type: String },
      passcode: { type: String },
      recordingUrl: { type: String },
    },
    resources: [String],
    agenda: { type: String, trim: true },
    outcomes: [String],
    chat: {
      enabled: { type: Boolean, default: true },
      expiresAt: { type: Date },
      messageCount: { type: Number, default: 0 },
    },
    feedback: {
      averageRating: { type: Number, default: 0, min: 0, max: 5 },
      totalFeedbacks: { type: Number, default: 0 },
      comments: [
        {
          menteeId: { type: String, required: true },
          rating: { type: Number, required: true, min: 1, max: 5 },
          comment: { type: String, trim: true },
          submittedAt: { type: Date, default: Date.now },
        },
      ],
    },
    cancellation: {
      cancelledAt: { type: Date },
      reason: { type: String, trim: true },
      refundsProcessed: { type: Boolean, default: false },
    },
    completion: {
      completedAt: { type: Date },
      actualDuration: { type: Number },
      attendanceCount: { type: Number, default: 0 },
      certificatesIssued: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: function (_doc, ret) {
        ret.id = ret.sessionId;
        delete (ret as any)._id;
        delete (ret as any).__v;
        return ret;
      }
    },
    toObject: { virtuals: true },
  }
);

// Indexes
GroupSessionSchema.index({ 'participants.menteeId': 1 });
GroupSessionSchema.index({ scheduledAt: 1, status: 1 });
GroupSessionSchema.index({ mentorId: 1, status: 1 });
GroupSessionSchema.index({ topic: 1, scheduledAt: 1 });
// ✅ NEW: mentor dashboard "pending requests" queries filter on this a lot
GroupSessionSchema.index({ mentorId: 1, 'participants.requestStatus': 1 });

// Virtuals
// ✅ CHANGED: isFull / hasMinParticipants / spotsRemaining now only count
// ACCEPTED participants. Pending join-requests no longer occupy a seat.
GroupSessionSchema.virtual('isFull').get(function (this: GroupSessionDocument) {
  const acceptedCount = (this.participants || []).filter(
    (p: IParticipant) => p.requestStatus === 'accepted'
  ).length;
  return acceptedCount >= this.maxParticipants;
});

GroupSessionSchema.virtual('hasMinParticipants').get(function (this: GroupSessionDocument) {
  const acceptedCount = (this.participants || []).filter(
    (p: IParticipant) => p.requestStatus === 'accepted'
  ).length;
  return acceptedCount >= this.minParticipants;
});

GroupSessionSchema.virtual('spotsRemaining').get(function (this: GroupSessionDocument) {
  const acceptedCount = (this.participants || []).filter(
    (p: IParticipant) => p.requestStatus === 'accepted'
  ).length;
  return Math.max(0, this.maxParticipants - acceptedCount);
});

GroupSessionSchema.virtual('canStart').get(function (this: GroupSessionDocument) {
  return (
    this.status === 'open' &&
    this.hasMinParticipants &&
    new Date() >= new Date(this.scheduledAt.getTime() - 15 * 60 * 1000)
  );
});

// Instance Methods

// ✅ CHANGED: addParticipant now creates a PENDING join request instead of
// an instantly-registered seat. It does NOT bump currentParticipants and
// does NOT flip status to 'full' — that only happens once the mentor
// accepts (see acceptParticipant below). isFull is checked against the
// virtual (accepted-only), so a pile of pending requests can never block
// new requests from coming in.
GroupSessionSchema.methods.addParticipant = async function (
  this: GroupSessionDocument,
  menteeId: string,
  transactionId?: string
): Promise<GroupSessionDocument> {
  if (this.isFull) {
    throw new Error('Session is full');
  }

  const existingParticipant = this.participants.find(
    (p: IParticipant) => p.menteeId === menteeId
  );

  if (existingParticipant) {
    if (existingParticipant.requestStatus === 'pending') {
      throw new Error('Join request already sent and awaiting mentor approval');
    }
    if (existingParticipant.requestStatus === 'accepted') {
      throw new Error('Already registered for this session');
    }
    // requestStatus === 'rejected' -> allow re-requesting by resetting the entry
    existingParticipant.requestStatus = 'pending';
    existingParticipant.registeredAt = new Date();
    existingParticipant.respondedAt = undefined;
    existingParticipant.transactionId = transactionId;
    existingParticipant.paymentStatus = transactionId ? 'completed' : 'pending';
    existingParticipant.paidAt = transactionId ? new Date() : undefined;
    return await this.save();
  }

  this.participants.push({
    menteeId,
    registeredAt: new Date(),
    paymentStatus: transactionId ? 'completed' : 'pending',
    transactionId,
    paidAt: transactionId ? new Date() : undefined,
    attendanceStatus: 'registered',
    requestStatus: 'pending',
  } as IParticipant);

  // currentParticipants intentionally NOT incremented here — it only
  // reflects accepted participants (kept in sync by acceptParticipant).

  return await this.save();
};

GroupSessionSchema.methods.removeParticipant = async function (
  this: GroupSessionDocument,
  menteeId: string
): Promise<GroupSessionDocument> {
  const index = this.participants.findIndex(
    (p: IParticipant) => p.menteeId === menteeId
  );

  if (index === -1) {
    throw new Error('Participant not found');
  }

  const wasAccepted = this.participants[index].requestStatus === 'accepted';
  this.participants.splice(index, 1);

  if (wasAccepted) {
    this.currentParticipants = this.participants.filter(
      (p: IParticipant) => p.requestStatus === 'accepted'
    ).length;
    if (this.status === 'full') {
      this.status = 'open';
    }
  }

  return await this.save();
};

GroupSessionSchema.methods.markAttendance = async function (
  this: GroupSessionDocument,
  menteeId: string,
  attended: boolean
): Promise<GroupSessionDocument> {
  const participant = this.participants.find(
    (p: IParticipant) => p.menteeId === menteeId
  );

  if (!participant) {
    throw new Error('Participant not found');
  }

  participant.attendanceStatus = attended ? 'attended' : 'absent';
  return await this.save();
};

// ✅ NEW: mentor approves a pending join request.
// This is the moment the mentee actually occupies a seat.
GroupSessionSchema.methods.acceptParticipant = async function (
  this: GroupSessionDocument,
  menteeId: string
): Promise<GroupSessionDocument> {
  const participant = this.participants.find(
    (p: IParticipant) => p.menteeId === menteeId
  );

  if (!participant) {
    throw new Error('Join request not found for this participant');
  }

  if (participant.requestStatus === 'accepted') {
    throw new Error('This request has already been accepted');
  }

  if (participant.requestStatus === 'rejected') {
    throw new Error('This request was already rejected. Ask the mentee to request again.');
  }

  const acceptedCount = this.participants.filter(
    (p: IParticipant) => p.requestStatus === 'accepted'
  ).length;

  if (acceptedCount >= this.maxParticipants) {
    throw new Error('Session is already full');
  }

  participant.requestStatus = 'accepted';
  participant.respondedAt = new Date();

  this.currentParticipants = acceptedCount + 1;

  if (this.currentParticipants >= this.maxParticipants) {
    this.status = 'full';
  }

  return await this.save();
};

// ✅ NEW: mentor rejects a pending join request.
GroupSessionSchema.methods.rejectParticipant = async function (
  this: GroupSessionDocument,
  menteeId: string
): Promise<GroupSessionDocument> {
  const participant = this.participants.find(
    (p: IParticipant) => p.menteeId === menteeId
  );

  if (!participant) {
    throw new Error('Join request not found for this participant');
  }

  if (participant.requestStatus === 'accepted') {
    throw new Error('Cannot reject a request that was already accepted. Remove the participant instead.');
  }

  participant.requestStatus = 'rejected';
  participant.respondedAt = new Date();

  return await this.save();
};

GroupSessionSchema.methods.startSession = async function (
  this: GroupSessionDocument
): Promise<GroupSessionDocument> {
  if (!this.canStart) {
    throw new Error('Cannot start session: minimum participants not met');
  }

  this.status = 'in_progress';
  return await this.save();
};

GroupSessionSchema.methods.completeSession = async function (
  this: GroupSessionDocument,
  actualDuration?: number
): Promise<GroupSessionDocument> {
  this.status = 'completed';
  const attendanceCount = this.participants.filter(
    (p: IParticipant) => p.attendanceStatus === 'attended'
  ).length;

  this.completion = {
    completedAt: new Date(),
    actualDuration: actualDuration || this.duration,
    attendanceCount,
    certificatesIssued: 0,
  };

  if (this.chat?.enabled) {
    this.chat.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  return await this.save();
};

GroupSessionSchema.methods.cancelSession = async function (
  this: GroupSessionDocument,
  reason: string
): Promise<GroupSessionDocument> {
  this.status = 'cancelled';
  this.cancellation = {
    cancelledAt: new Date(),
    reason,
    refundsProcessed: false,
  };
  return await this.save();
};

GroupSessionSchema.methods.addFeedback = async function (
  this: GroupSessionDocument,
  menteeId: string,
  rating: number,
  comment?: string
): Promise<GroupSessionDocument> {
  if (!this.feedback) {
    this.feedback = {
      averageRating: 0,
      totalFeedbacks: 0,
      comments: [],
    };
  }

  const existingFeedback = this.feedback.comments.find(
    (f: any) => f.menteeId === menteeId
  );

  if (existingFeedback) {
    throw new Error('Feedback already submitted');
  }

  this.feedback.comments.push({
    menteeId,
    rating,
    comment,
    submittedAt: new Date(),
  } as any);

  const totalRating = this.feedback.comments.reduce((sum: number, f: any) => sum + f.rating, 0);
  this.feedback.averageRating = totalRating / this.feedback.comments.length;
  this.feedback.totalFeedbacks = this.feedback.comments.length;

  return await this.save();
};

GroupSessionSchema.methods.issueCertificate = async function (
  this: GroupSessionDocument,
  menteeId: string,
  certificateUrl: string
): Promise<GroupSessionDocument> {
  const participant = this.participants.find(
    (p: IParticipant) => p.menteeId === menteeId
  );

  if (!participant) {
    throw new Error('Participant not found');
  }

  if (participant.attendanceStatus !== 'attended') {
    throw new Error('Certificate can only be issued to attendees');
  }

  participant.certificate = {
    issued: true,
    issuedAt: new Date(),
    certificateUrl,
  };

  if (this.completion) {
    this.completion.certificatesIssued = (this.completion.certificatesIssued || 0) + 1;
  }

  return await this.save();
};

// Static Methods
GroupSessionSchema.statics.findUpcoming = function (mentorId?: string) {
  const query: any = {
    scheduledAt: { $gt: new Date() },
    status: { $in: ['open', 'full'] },
  };

  if (mentorId) {
    query.mentorId = mentorId;
  }

  return this.find(query).sort({ scheduledAt: 1 });
};

GroupSessionSchema.statics.findByTopic = function (topic: string) {
  return this.find({
    topic: new RegExp(topic, 'i'),
    status: 'open',
    scheduledAt: { $gt: new Date() },
  }).sort({ scheduledAt: 1 });
};

export default mongoose.model<GroupSessionDocument>('GroupSession', GroupSessionSchema);