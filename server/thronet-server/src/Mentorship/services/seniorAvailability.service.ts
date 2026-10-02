import { DateTime } from 'luxon';
import seniorAvailabilityRepository from '../repositories/seniorAvailability.repository';
import SeniorSession from '../models/SeniorSession';
import { SeniorSessionStatus } from '../interface/seniorSession.types';
import { CreateSeniorAvailabilityInput, UpdateSeniorAvailabilityInput, SeniorTimeRange, SeniorDateOverride } from '../interface/seniorAvailability.types';

export class SeniorAvailabilityService {
  /**
   * Upsert the user's weekly config
   */
  async upsertConfig(mentorId: string, input: CreateSeniorAvailabilityInput | UpdateSeniorAvailabilityInput) {
    return await seniorAvailabilityRepository.upsert(mentorId, input);
  }

  /**
   * Get configuration
   */
  async getConfig(mentorId: string) {
    return await seniorAvailabilityRepository.getByMentorId(mentorId);
  }
  
  /**
   * Block a specific time manually
   */
  async addBlockedTime(mentorId: string, date: string, startTime: string, endTime: string, reason?: string) {
    const config = await this.getConfig(mentorId);
    if (!config) throw new Error('Senior Mentor availability config not found');
    return await seniorAvailabilityRepository.addBlockedTime(mentorId, { date, startTime, endTime, reason });
  }

  /**
   * Remove a manually blocked time
   */
  async removeBlockedTime(mentorId: string, id: string) {
    return await seniorAvailabilityRepository.removeBlockedTime(mentorId, id);
  }

  /**
   * Check if two time ranges overlap
   */
  private checkOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
    const toMinutes = (timeStr: string) => {
      const [h, m] = timeStr.split(':').map(Number);
      return h * 60 + m;
    };
    return toMinutes(startA) < toMinutes(endB) && toMinutes(endA) > toMinutes(startB);
  }

  /**
   * Core logic to fetch valid available slots for a given date
   */
  async getAvailableSlots(mentorId: string, dateStr: string, sessionDuration: number): Promise<{ startTime: string, endTime: string }[]> {
    const config = await this.getConfig(mentorId);
    if (!config) {
      return []; // No config = no availability
    }

    // 1. Resolve which time ranges apply to this date
    // Check if it's completely overridden
    const override = config.dateOverrides.find(o => o.date === dateStr);
    let timeRanges: SeniorTimeRange[] = [];
    
    if (override) {
      if (!override.enabled) return []; // Date is completely blocked by override
      timeRanges = override.timeRanges;
    } else {
      // Find the weekday
      // Using luxon to parse the date in the configured timezone to determine the day
      const dateInTz = DateTime.fromISO(dateStr, { zone: config.timezone });
      const dayName = dateInTz.setLocale('en-US').toFormat('cccc'); // "Monday", "Tuesday"
      
      const daySchedule = config.weeklySchedule.find(d => d.day === dayName);
      if (!daySchedule || !daySchedule.enabled) {
        return []; // Disabled for this day
      }
      timeRanges = daySchedule.timeRanges;
    }

    if (timeRanges.length === 0) return [];

    // 2. Fetch existing sessions to exclude overlapping blocks
    // This is important because existing sessions eat up the time ranges.
    const startOfDay = DateTime.fromISO(dateStr, { zone: config.timezone }).startOf('day').toJSDate();
    const endOfDay = DateTime.fromISO(dateStr, { zone: config.timezone }).endOf('day').toJSDate();

    // Fetch existing active/upcoming sessions on that day
    const existingSessions = await SeniorSession.find({
      mentorId,
      status: { $nin: [SeniorSessionStatus.CANCELLED, SeniorSessionStatus.COMPLETED] },
      scheduledAt: { $gte: startOfDay, $lte: endOfDay }
    }).lean();

    // Convert sessions to HH:mm blocks within the timezone
    const sessionBlocks = existingSessions.map(sess => {
      // sess.scheduledAt is stored as UTC Date. We need to project it to the mentor's timezone.
      const sessStart = DateTime.fromJSDate(sess.scheduledAt).setZone(config.timezone);
      const sessEnd = sessStart.plus({ minutes: sess.duration });
      
      return {
        startTime: sessStart.toFormat('HH:mm'),
        endTime: sessEnd.toFormat('HH:mm'),
        duration: sess.duration
      };
    });

    // 3. Add manual blocked times to the exclusions
    const blockedTimes = config.blockedTimes.filter(b => b.date === dateStr);
    const exclusions = [...sessionBlocks, ...blockedTimes];

    // 4. Generate all potential slots and filter them
    const validSlots: { startTime: string, endTime: string }[] = [];
    const interval = config.slotInterval > 0 ? config.slotInterval : 30; // default 30
    
    const toMinutes = (timeStr: string) => {
      const [h, m] = timeStr.split(':').map(Number);
      return h * 60 + m;
    };

    const toTimeStr = (minutes: number) => {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // For every time range on the day, generate intervals
    for (const range of timeRanges) {
      let currentMin = toMinutes(range.startTime);
      const endMin = toMinutes(range.endTime);

      while (currentMin + sessionDuration <= endMin) {
        const slotStart = toTimeStr(currentMin);
        const slotEnd = toTimeStr(currentMin + sessionDuration);

        // Check if [slotStart, slotEnd] overlaps with ANY exclusion
        let isExcluded = false;
        for (const excl of exclusions) {
          if (this.checkOverlap(slotStart, slotEnd, excl.startTime, excl.endTime)) {
            isExcluded = true;
            break;
          }
        }

        if (!isExcluded) {
          // Additional check: Don't allow slots in the past
          // Construct the slot datetime and compare with 'now'
          const slotDateTime = DateTime.fromISO(`${dateStr}T${slotStart}:00`, { zone: config.timezone });
          if (slotDateTime > DateTime.now().setZone(config.timezone)) {
            validSlots.push({
              startTime: slotStart,
              endTime: slotEnd
            });
          }
        }

        // Advance by the slot interval + break duration
        currentMin += interval + config.breakDuration;
      }
    }

    return validSlots;
  }

  /**
   * Validate if a specifically requested time slot is still valid and not overlapping.
   * Called by SeniorSessionService before booking/persisting to avoid race conditions.
   * 
   * @param excludeSessionId Used during UPDATE to prevent the session from blocking itself.
   */
  async validateSlot(mentorId: string, dateStr: string, startTime: string, duration: number, excludeSessionId?: string): Promise<boolean> {
    const config = await this.getConfig(mentorId);
    if (!config) return false;

    const toMinutes = (timeStr: string) => {
      const [h, m] = timeStr.split(':').map(Number);
      return h * 60 + m;
    };
    
    const toTimeStr = (minutes: number) => {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const startMin = toMinutes(startTime);
    const endTime = toTimeStr(startMin + duration);

    // 1. Must be within the configured time ranges for that date/day
    const override = config.dateOverrides.find(o => o.date === dateStr);
    let timeRanges: SeniorTimeRange[] = [];
    
    if (override) {
      if (!override.enabled) return false; // Date is completely blocked
      timeRanges = override.timeRanges;
    } else {
      const dateInTz = DateTime.fromISO(dateStr, { zone: config.timezone });
      const dayName = dateInTz.setLocale('en-US').toFormat('cccc'); // "Monday", etc.
      
      const daySchedule = config.weeklySchedule.find(d => d.day === dayName);
      if (!daySchedule || !daySchedule.enabled) return false;
      timeRanges = daySchedule.timeRanges;
    }

    let isInsideRange = false;
    for (const range of timeRanges) {
      if (startMin >= toMinutes(range.startTime) && toMinutes(endTime) <= toMinutes(range.endTime)) {
        isInsideRange = true;
        break;
      }
    }

    if (!isInsideRange) return false;

    // 2. Cannot be in the past
    const slotDateTime = DateTime.fromISO(`${dateStr}T${startTime}:00`, { zone: config.timezone });
    if (slotDateTime <= DateTime.now().setZone(config.timezone)) {
      return false; // Time has already passed
    }

    // 3. Cannot overlap with manually blocked times
    const blockedTimes = config.blockedTimes.filter(b => b.date === dateStr);
    for (const blocked of blockedTimes) {
      if (this.checkOverlap(startTime, endTime, blocked.startTime, blocked.endTime)) return false;
    }

    // 4. Cannot overlap with other active Senior Sessions for this mentor
    const startOfDay = DateTime.fromISO(dateStr, { zone: config.timezone }).startOf('day').toJSDate();
    const endOfDay = DateTime.fromISO(dateStr, { zone: config.timezone }).endOf('day').toJSDate();

    const query: any = {
      mentorId,
      status: { $nin: [SeniorSessionStatus.CANCELLED, SeniorSessionStatus.COMPLETED] },
      scheduledAt: { $gte: startOfDay, $lte: endOfDay }
    };
    if (excludeSessionId) {
      query.sessionId = { $ne: excludeSessionId }; // Exclude the session being edited
    }

    const existingSessions = await SeniorSession.find(query).lean();
    for (const sess of existingSessions) {
      const sessStart = DateTime.fromJSDate(sess.scheduledAt).setZone(config.timezone);
      const sessStartStr = sessStart.toFormat('HH:mm');
      const sessEndStr = sessStart.plus({ minutes: sess.duration }).toFormat('HH:mm');
      
      if (this.checkOverlap(startTime, endTime, sessStartStr, sessEndStr)) {
        return false; // Slot is occupied by another session!
      }
    }

    return true; // Everything is clean and valid
  }
}

export default new SeniorAvailabilityService();
