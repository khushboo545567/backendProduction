import mongoose from "mongoose";
import { WithdrawalMethod, IWithdrawalMethod } from "../models/WithdrawalMethod";

export class WithdrawalService {
  // ── Get all methods for a mentor ────────────────────────────────────────
  async getMethods(mentorId: string): Promise<IWithdrawalMethod[]> {
    return WithdrawalMethod.find({ mentorId }).sort({ isDefault: -1, createdAt: -1 });
  }

  // ── Add a new method ─────────────────────────────────────────────────────
  async addMethod(
    mentorId: string,
    payload: Partial<IWithdrawalMethod>
  ): Promise<IWithdrawalMethod> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // If this is first method or marked as default → unset others
      const existingCount = await WithdrawalMethod.countDocuments({ mentorId }).session(session);
      const makeDefault = existingCount === 0 || payload.isDefault;

      if (makeDefault) {
        await WithdrawalMethod.updateMany(
          { mentorId },
          { isDefault: false },
          { session }
        );
      }

      const method = await WithdrawalMethod.create(
        [{ ...payload, mentorId, isDefault: !!makeDefault }],
        { session }
      );

      await session.commitTransaction();
      return method[0];
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ── Set a method as default ──────────────────────────────────────────────
  async setDefault(mentorId: string, methodId: string): Promise<IWithdrawalMethod | null> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await WithdrawalMethod.updateMany(
        { mentorId },
        { isDefault: false },
        { session }
      );

      const updated = await WithdrawalMethod.findOneAndUpdate(
        { _id: methodId, mentorId },
        { isDefault: true },
        { new: true, session }
      );

      if (!updated) throw new Error("Method not found");

      await session.commitTransaction();
      return updated;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ── Delete a method ──────────────────────────────────────────────────────
  async deleteMethod(mentorId: string, methodId: string): Promise<void> {
    const method = await WithdrawalMethod.findOneAndDelete({ _id: methodId, mentorId });
    if (!method) throw new Error("Method not found");

    // If deleted method was default → make latest remaining one default
    if (method.isDefault) {
      await WithdrawalMethod.findOneAndUpdate(
        { mentorId },
        { isDefault: true },
        { sort: { createdAt: -1 } }
      );
    }
  }
}

export const withdrawalService = new WithdrawalService();