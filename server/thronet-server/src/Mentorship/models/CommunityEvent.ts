import mongoose, { Schema, Document } from 'mongoose';

export interface ICommunityEvent extends Document {
  title: string;
  description?: string;
  date: Date;
  type: 'meetup' | 'webinar' | 'workshop' | 'networking';
  createdBy: string;
  participantsCount: number;
  resourceLink?: string;
  imageUrl?: string;
  isCancelled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CommunityEventSchema = new Schema<ICommunityEvent>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    date: { type: Date, required: true },
    type: {
      type: String,
      enum: ['meetup', 'webinar', 'workshop', 'networking'],
      default: 'meetup',
    },
    createdBy: { type: String, required: true, index: true },
    participantsCount: { type: Number, default: 0 },
    resourceLink: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    isCancelled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

CommunityEventSchema.index({ date: 1, isCancelled: 1 });

export default mongoose.model<ICommunityEvent>('CommunityEvent', CommunityEventSchema);