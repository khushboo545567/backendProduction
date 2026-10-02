export interface SeniorTimeRange {
  startTime: string; // HH:mm format
  endTime: string;   // HH:mm format
}

export interface SeniorDaySchedule {
  day: string; // "Monday", "Tuesday", etc.
  enabled: boolean;
  timeRanges: SeniorTimeRange[];
}

export interface SeniorDateOverride {
  date: string; // YYYY-MM-DD
  enabled: boolean;
  timeRanges: SeniorTimeRange[];
}

export interface SeniorBlockedTime {
  _id?: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm format
  endTime: string;   // HH:mm format
  reason?: string;
}

export interface CreateSeniorAvailabilityInput {
  timezone: string;
  weeklySchedule: SeniorDaySchedule[];
  slotInterval: number; // in minutes
  breakDuration: number; // in minutes
}

export interface UpdateSeniorAvailabilityInput {
  timezone?: string;
  weeklySchedule?: SeniorDaySchedule[];
  slotInterval?: number;
  breakDuration?: number;
  dateOverrides?: SeniorDateOverride[];
  blockedTimes?: SeniorBlockedTime[];
}
