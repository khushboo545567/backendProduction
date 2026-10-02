import SeniorAvailability, { SeniorAvailabilityDocument } from '../models/SeniorAvailability';
import { CreateSeniorAvailabilityInput, UpdateSeniorAvailabilityInput } from '../interface/seniorAvailability.types';

export class SeniorAvailabilityRepository {
  /**
   * Get availability configuration for a specific mentor.
   */
  async getByMentorId(mentorId: string): Promise<SeniorAvailabilityDocument | null> {
    return await SeniorAvailability.findOne({ mentorId });
  }

  /**
   * Create or update the availability configuration for a mentor.
   */
  async upsert(mentorId: string, input: CreateSeniorAvailabilityInput | UpdateSeniorAvailabilityInput): Promise<SeniorAvailabilityDocument> {
    let config = await SeniorAvailability.findOne({ mentorId });
    
    if (!config) {
      // Create new configuration
      config = new SeniorAvailability({
        mentorId,
        timezone: input.timezone,
        weeklySchedule: input.weeklySchedule || [],
        slotInterval: input.slotInterval || 30,
        breakDuration: input.breakDuration || 0,
      });
      return await config.save();
    }

    // Update existing configuration
    if (input.timezone !== undefined) config.timezone = input.timezone;
    if (input.weeklySchedule !== undefined) config.weeklySchedule = input.weeklySchedule;
    if (input.slotInterval !== undefined) config.slotInterval = input.slotInterval;
    if (input.breakDuration !== undefined) config.breakDuration = input.breakDuration;
    
    // For date overrides and blocked times, the service layer will handle them directly 
    // or pass them down in the update payload.
    if ('dateOverrides' in input && input.dateOverrides !== undefined) {
      config.dateOverrides = input.dateOverrides;
    }
    if ('blockedTimes' in input && input.blockedTimes !== undefined) {
      config.blockedTimes = input.blockedTimes;
    }

    return await config.save();
  }

  /**
   * Helper to append a single blocked time to the array.
   */
  async addBlockedTime(mentorId: string, blockedTime: { date: string, startTime: string, endTime: string, reason?: string }): Promise<SeniorAvailabilityDocument | null> {
    return await SeniorAvailability.findOneAndUpdate(
      { mentorId },
      { $push: { blockedTimes: blockedTime } },
      { new: true }
    );
  }

  /**
   * Helper to remove a single blocked time by _id.
   */
  async removeBlockedTime(mentorId: string, blockedTimeId: string): Promise<SeniorAvailabilityDocument | null> {
    return await SeniorAvailability.findOneAndUpdate(
      { mentorId },
      { $pull: { blockedTimes: { _id: blockedTimeId } } },
      { new: true }
    );
  }
}

export default new SeniorAvailabilityRepository();
