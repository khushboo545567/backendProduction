import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IEventRSVP extends Document {
  event: Types.ObjectId;
  user: Types.ObjectId;
  status: 'going' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

const EventRSVPSchema = new Schema<IEventRSVP>(
  {
    event: { type: Schema.Types.ObjectId, ref: 'CommunityEvent', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['going', 'cancelled'], default: 'going' },
  },
  { timestamps: true }
);

// Prevent duplicate RSVP rows per user per event — one doc per pair, status toggles.
EventRSVPSchema.index({ event: 1, user: 1 }, { unique: true });
EventRSVPSchema.index({ event: 1, status: 1 });

export default mongoose.model<IEventRSVP>('EventRSVP', EventRSVPSchema);