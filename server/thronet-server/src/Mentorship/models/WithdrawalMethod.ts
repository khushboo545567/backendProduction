import mongoose, { Document, Schema } from "mongoose";

export interface IWithdrawalMethod extends Document {
  // Mentor ki id UUID string hai (ObjectId nahi)
  mentorId: string;
  type: "bank" | "upi";

  // Bank fields
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  ifscCode?: string;
  accountType?: "savings" | "current";

  // UPI fields
  upiId?: string;
  upiName?: string;

  isDefault: boolean;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WithdrawalMethodSchema = new Schema<IWithdrawalMethod>(
  {
    mentorId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["bank", "upi"],
      required: true,
    },

    // Bank
    bankName: { type: String, trim: true },
    accountHolderName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifscCode: { type: String, trim: true, uppercase: true },
    accountType: { type: String, enum: ["savings", "current"] },

    // UPI
    upiId: { type: String, trim: true, lowercase: true },
    upiName: { type: String, trim: true },

    isDefault: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Fast lookup of a mentor's default method
WithdrawalMethodSchema.index(
  { mentorId: 1, isDefault: 1 },
  { unique: false }
);

export const WithdrawalMethod = mongoose.model<IWithdrawalMethod>(
  "WithdrawalMethod",
  WithdrawalMethodSchema
);