import mongoose, { Schema, Document } from 'mongoose';
import { SeniorDaySchedule, SeniorDateOverride, SeniorBlockedTime } from '../interface/seniorAvailability.types';

export interface ISeniorAvailability {
  mentorId: string;
  timezone: string;
  weeklySchedule: SeniorDaySchedule[];
  slotInterval: number; // e.g., 30 minutes
  breakDuration: number; // e.g., 15 minutes
  dateOverrides: SeniorDateOverride[];
  blockedTimes: SeniorBlockedTime[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SeniorAvailabilityDocument extends ISeniorAvailability, Document {}

const TimeRangeSchema = new Schema(
  {
    startTime: { type: String, required: true, match: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/ },
    endTime: { type: String, required: true, match: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/ },
  },
  { _id: false }
);

const DayScheduleSchema = new Schema(
  {
    day: { 
      type: String, 
      required: true, 
      enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] 
    },
    enabled: { type: Boolean, default: false },
    timeRanges: { type: [TimeRangeSchema], default: [] },
  },
  { _id: false }
);

const DateOverrideSchema = new Schema(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // YYYY-MM-DD
    enabled: { type: Boolean, default: true },
    timeRanges: { type: [TimeRangeSchema], default: [] },
  },
  { _id: true } // allow targeted removal
);

const BlockedTimeSchema = new Schema(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // YYYY-MM-DD
    startTime: { type: String, required: true, match: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/ },
    endTime: { type: String, required: true, match: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/ },
    reason: { type: String },
  },
  { _id: true } // allow targeted removal
);

const SeniorAvailabilitySchema = new Schema<SeniorAvailabilityDocument>(
  {
    mentorId: { 
      type: String, 
      required: [true, 'Mentor ID is required'], 
      unique: true, 
      index: true 
    },
    timezone: { 
      type: String, 
      required: [true, 'Timezone is required'], 
      default: 'UTC' 
    },
    weeklySchedule: { 
      type: [DayScheduleSchema], 
      default: [] 
    },
    slotInterval: { 
      type: Number, 
      default: 30, // default 30 mins 
    },
    breakDuration: { 
      type: Number, 
      default: 0, // default 0 mins
    },
    dateOverrides: { 
      type: [DateOverrideSchema], 
      default: [] 
    },
    blockedTimes: { 
      type: [BlockedTimeSchema], 
      default: [] 
    },
  },
  {
    timestamps: true,
  }
);

// Initialization hook to ensure default schedule exists
SeniorAvailabilitySchema.pre('save', function (next) {
  if (this.isNew && this.weeklySchedule.length === 0) {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    this.weeklySchedule = days.map(day => ({
      day,
      enabled: false,
      timeRanges: [{ startTime: '09:00', endTime: '17:00' }]
    }));
  }
  next();
});

export default mongoose.model<SeniorAvailabilityDocument>('SeniorAvailability', SeniorAvailabilitySchema);
