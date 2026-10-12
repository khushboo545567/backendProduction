import { DateTime } from 'luxon';
import seniorAvailabilityRepository from '../repositories/seniorAvailability.repository';
import SeniorSession from '../models/SeniorSession';
import Mentor from '../models/Mentor';
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
   * Helper to resolve canonical mentorId and any verified aliases (e.g. Standard Mentor profile ID <-> userId).
   */
  async resolveMentorIds(mentorId: string): Promise<string[]> {
    const ids = [mentorId];
    try {
      const standardMentor = await Mentor.findOne({
        $or: [{ mentorId }, { userId: mentorId }],
        isDeleted: false
      }).lean();

      if (standardMentor) {
        if (standardMentor.userId && !ids.includes(standardMentor.userId)) {
          ids.push(standardMentor.userId);
        }
        if (standardMentor.mentorId && !ids.includes(standardMentor.mentorId)) {
          ids.push(standardMentor.mentorId);
        }
      }
    } catch {
      // Ignore lookup failure and proceed with original ID
    }
    return ids;
  }

  /**
   * Helper to extract all booked blocks for a given date from both root session schedules and nested booking subdocuments.
   */
  private extractBookedBlocksForDate(sessions: any[], dateStr: string, timezone: string): Array<{ startTime: string; endTime: string }> {
    const blocks: Array<{ startTime: string; endTime: string }> = [];

    for (const sess of sessions) {
      // 1. Root-level session scheduling (only for group sessions; one_to_one sessions are service templates)
      if (sess.scheduledAt && sess.sessionType === 'group') {
        const sessStart = DateTime.fromJSDate(sess.scheduledAt).setZone(timezone);
        if (sessStart.toFormat('yyyy-MM-dd') === dateStr) {
          const sessEnd = sessStart.plus({ minutes: sess.duration || 60 });
          blocks.push({
            startTime: sessStart.toFormat('HH:mm'),
            endTime: sessEnd.toFormat('HH:mm')
          });
        }
      }

      // 2. Nested bookings subdocuments
      if (sess.bookings && Array.isArray(sess.bookings)) {
        for (const b of sess.bookings) {
          if (['cancelled', 'rejected'].includes(b.status)) continue;

          if (b.scheduledAt) {
            const bStart = DateTime.fromJSDate(b.scheduledAt).setZone(timezone);
            if (bStart.toFormat('yyyy-MM-dd') === dateStr) {
              let startTimeStr = bStart.toFormat('HH:mm');
              let endTimeStr = bStart.plus({ minutes: sess.duration || 60 }).toFormat('HH:mm');
              if (b.slotTime && typeof b.slotTime === 'string') {
                const parts = (b.slotTime as string).split('-').map((s: string) => s.trim());
                if (parts.length === 2 && parts[0] && parts[1]) {
                  startTimeStr = parts[0];
                  endTimeStr = parts[1];
                }
              }
              blocks.push({ startTime: startTimeStr, endTime: endTimeStr });
            }
          } else if (b.slotTime && typeof b.slotTime === 'string') {
            const parts = (b.slotTime as string).split('-').map((s: string) => s.trim());
            if (parts.length === 2 && parts[0] && parts[1]) {
              blocks.push({ startTime: parts[0], endTime: parts[1] });
            }
          }
        }
      }
    }

    return blocks;
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

    // Fetch existing active/upcoming sessions on that day matching root scheduledAt OR nested bookings
    const resolvedIds = await this.resolveMentorIds(mentorId);
    const existingSessions = await SeniorSession.find({
      mentorId: { $in: resolvedIds },
      status: { $nin: [SeniorSessionStatus.CANCELLED] },
      $or: [
        { scheduledAt: { $gte: startOfDay, $lte: endOfDay } },
        { 'bookings.scheduledAt': { $gte: startOfDay, $lte: endOfDay } }
      ]
    }).lean();

    const sessionBlocks = this.extractBookedBlocksForDate(existingSessions, dateStr, config.timezone);

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
   * Fetch month-level availability and slots for a given date range.
   * Generates discrete candidate slots using configured working hours, slot interval,
   * break duration, and sessionDuration, then marks their actual status:
   * 'available' | 'booked' | 'blocked' | 'past'.
   */
  async getMonthlyAvailability(
    mentorId: string,
    startDateStr: string,
    endDateStr: string,
    sessionDuration: number = 60
  ): Promise<
    Array<{
      date: string;
      isDateBlocked: boolean;
      totalSlots: number;
      availableSlots: number;
      bookedSlots: number;
      blockedSlots: number;
      slots: Array<{
        startTime: string;
        endTime: string;
        status: 'available' | 'booked' | 'blocked' | 'past';
        isBooked: boolean;
        isBlocked: boolean;
      }>;
    }>
  > {
    const config = await this.getConfig(mentorId);
    const timezone = config?.timezone || 'Asia/Kolkata';

    const startDt = DateTime.fromISO(startDateStr, { zone: timezone });
    const endDt = DateTime.fromISO(endDateStr, { zone: timezone });

    if (!startDt.isValid || !endDt.isValid || startDt > endDt) {
      return [];
    }

    // Fetch all active/relevant sessions across the entire date range
    const rangeStartJS = startDt.startOf('day').toJSDate();
    const rangeEndJS = endDt.endOf('day').toJSDate();

    const resolvedIds = await this.resolveMentorIds(mentorId);
    const existingSessions = await SeniorSession.find({
      mentorId: { $in: resolvedIds },
      status: { $nin: [SeniorSessionStatus.CANCELLED] },
      $or: [
        { scheduledAt: { $gte: rangeStartJS, $lte: rangeEndJS } },
        { 'bookings.scheduledAt': { $gte: rangeStartJS, $lte: rangeEndJS } }
      ]
    }).lean();

    const toMinutes = (timeStr: string) => {
      const [h, m] = timeStr.split(':').map(Number);
      return h * 60 + m;
    };

    const toTimeStr = (minutes: number) => {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const nowInTz = DateTime.now().setZone(timezone);
    const effDuration = sessionDuration > 0 ? sessionDuration : 60;
    const interval = config && config.slotInterval > 0 ? config.slotInterval : 30;
    const breakDuration = config?.breakDuration ?? 0;

    const result: Array<{
      date: string;
      isDateBlocked: boolean;
      totalSlots: number;
      availableSlots: number;
      bookedSlots: number;
      blockedSlots: number;
      slots: Array<{
        startTime: string;
        endTime: string;
        status: 'available' | 'booked' | 'blocked' | 'past';
        isBooked: boolean;
        isBlocked: boolean;
      }>;
    }> = [];

    let currentDay = startDt.startOf('day');
    const endLimit = endDt.endOf('day');

    while (currentDay <= endLimit) {
      const dateStr = currentDay.toFormat('yyyy-MM-dd');

      if (!config) {
        result.push({
          date: dateStr,
          isDateBlocked: false,
          totalSlots: 0,
          availableSlots: 0,
          bookedSlots: 0,
          blockedSlots: 0,
          slots: []
        });
        currentDay = currentDay.plus({ days: 1 });
        continue;
      }

      // 1. Resolve schedule for this date
      const override = config.dateOverrides?.find(o => o.date === dateStr);
      let timeRanges: SeniorTimeRange[] = [];
      let isDayDisabled = false;

      if (override) {
        if (!override.enabled) {
          isDayDisabled = true;
          timeRanges = [];
        } else {
          timeRanges = override.timeRanges || [];
        }
      } else {
        const dayName = currentDay.setLocale('en-US').toFormat('cccc');
        const daySchedule = config.weeklySchedule?.find(d => d.day === dayName);
        if (!daySchedule || !daySchedule.enabled) {
          isDayDisabled = true;
          timeRanges = [];
        } else {
          timeRanges = daySchedule.timeRanges || [];
        }
      }

      // 2. Resolve blocked times for this date
      const dayBlockedTimes = (config.blockedTimes || []).filter(b => b.date === dateStr);

      // 3. Resolve booked sessions/blocks for this date
      const dayBookedBlocks = this.extractBookedBlocksForDate(existingSessions, dateStr, timezone);

      // 4. Generate candidate slots within configured timeRanges
      const daySlots: Array<{
        startTime: string;
        endTime: string;
        status: 'available' | 'booked' | 'blocked' | 'past';
        isBooked: boolean;
        isBlocked: boolean;
      }> = [];

      for (const range of timeRanges) {
        let currentMin = toMinutes(range.startTime);
        const endMin = toMinutes(range.endTime);

        while (currentMin + effDuration <= endMin) {
          const slotStart = toTimeStr(currentMin);
          const slotEnd = toTimeStr(currentMin + effDuration);

          // Check overlap with booked blocks
          let isBooked = false;
          for (const booked of dayBookedBlocks) {
            if (this.checkOverlap(slotStart, slotEnd, booked.startTime, booked.endTime)) {
              isBooked = true;
              break;
            }
          }

          // Check overlap with manually blocked times
          let isBlocked = false;
          if (!isBooked) {
            for (const blocked of dayBlockedTimes) {
              if (this.checkOverlap(slotStart, slotEnd, blocked.startTime, blocked.endTime)) {
                isBlocked = true;
                break;
              }
            }
          }

          // Check if slot has passed
          const slotDateTime = DateTime.fromISO(`${dateStr}T${slotStart}:00`, { zone: timezone });
          const isPast = slotDateTime <= nowInTz;

          let status: 'available' | 'booked' | 'blocked' | 'past' = 'available';
          if (isBooked) {
            status = 'booked';
          } else if (isBlocked) {
            status = 'blocked';
          } else if (isPast) {
            status = 'past';
          } else {
            status = 'available';
          }

          daySlots.push({
            startTime: slotStart,
            endTime: slotEnd,
            status,
            isBooked,
            isBlocked
          });

          currentMin += interval + breakDuration;
        }
      }

      const availableSlots = daySlots.filter(s => s.status === 'available').length;
      const bookedSlots = daySlots.filter(s => s.status === 'booked').length;
      const blockedSlots = daySlots.filter(s => s.status === 'blocked').length;
      const isPastDay = currentDay.endOf('day') < nowInTz;
      const isDateBlocked = isDayDisabled || (!isPastDay && daySlots.length > 0 && blockedSlots > 0 && availableSlots === 0 && bookedSlots === 0);

      result.push({
        date: dateStr,
        isDateBlocked,
        totalSlots: daySlots.length,
        availableSlots,
        bookedSlots,
        blockedSlots,
        slots: daySlots
      });

      currentDay = currentDay.plus({ days: 1 });
    }

    return result;
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

    // 4. Cannot overlap with other active Senior Sessions or nested bookings for this mentor
    const startOfDay = DateTime.fromISO(dateStr, { zone: config.timezone }).startOf('day').toJSDate();
    const endOfDay = DateTime.fromISO(dateStr, { zone: config.timezone }).endOf('day').toJSDate();

    const resolvedIds = await this.resolveMentorIds(mentorId);
    const query: any = {
      mentorId: { $in: resolvedIds },
      status: { $nin: [SeniorSessionStatus.CANCELLED] },
      $or: [
        { scheduledAt: { $gte: startOfDay, $lte: endOfDay } },
        { 'bookings.scheduledAt': { $gte: startOfDay, $lte: endOfDay } }
      ]
    };
    if (excludeSessionId) {
      query.sessionId = { $ne: excludeSessionId }; // Exclude the session being edited
    }

    const existingSessions = await SeniorSession.find(query).lean();
    const bookedBlocks = this.extractBookedBlocksForDate(existingSessions, dateStr, config.timezone);
    for (const block of bookedBlocks) {
      if (this.checkOverlap(startTime, endTime, block.startTime, block.endTime)) {
        return false; // Slot is occupied by another session or booking!
      }
    }

    return true; // Everything is clean and valid
  }
}

export default new SeniorAvailabilityService();
