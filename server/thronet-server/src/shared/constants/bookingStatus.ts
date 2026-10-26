export enum BookingStatus {
  AVAILABLE = 'available',
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  RESCHEDULED = 'rescheduled',
  NO_SHOW = 'no_show',
  MISSED = 'missed', // start window band ho gayi aur session kabhi start nahi hua
  REFUNDED = 'refunded',
}

export const BOOKING_STATUS_FLOW: Record<BookingStatus, BookingStatus[]> = {
  [BookingStatus.AVAILABLE]: [BookingStatus.PENDING, BookingStatus.CANCELLED],
  [BookingStatus.PENDING]: [BookingStatus.CONFIRMED, BookingStatus.CANCELLED, BookingStatus.MISSED],
  [BookingStatus.CONFIRMED]: [
    BookingStatus.IN_PROGRESS,
    BookingStatus.CANCELLED,
    BookingStatus.RESCHEDULED,
    BookingStatus.MISSED,
  ],
  [BookingStatus.IN_PROGRESS]: [BookingStatus.COMPLETED, BookingStatus.NO_SHOW],
  [BookingStatus.COMPLETED]: [],
  [BookingStatus.CANCELLED]: [BookingStatus.REFUNDED],
  [BookingStatus.RESCHEDULED]: [
    BookingStatus.CONFIRMED,
    BookingStatus.IN_PROGRESS,
    BookingStatus.CANCELLED,
    BookingStatus.MISSED,
  ],
  // Missed ke baad student ya to refund lega ya reschedule karega
  [BookingStatus.MISSED]: [BookingStatus.RESCHEDULED, BookingStatus.CANCELLED, BookingStatus.REFUNDED],
  [BookingStatus.NO_SHOW]: [],
  [BookingStatus.REFUNDED]: [],
};



export const CANCELLABLE_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
];

export const RESCHEDULABLE_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.MISSED,
];

export const REFUNDABLE_STATUSES: BookingStatus[] = [
  BookingStatus.CANCELLED,
  BookingStatus.MISSED,
];



export const FINAL_STATUSES: BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.NO_SHOW,
  BookingStatus.REFUNDED,
];

export const canTransitionTo = (
  currentStatus: BookingStatus,
  newStatus: BookingStatus
): boolean => {
  return BOOKING_STATUS_FLOW[currentStatus]?.includes(newStatus) || false;
};

export const isCancellable = (status: BookingStatus): boolean => {
  return CANCELLABLE_STATUSES.includes(status);
};

export const isReschedulable = (status: BookingStatus): boolean => {
  return RESCHEDULABLE_STATUSES.includes(status);
};

export const isFinalStatus = (status: BookingStatus): boolean => {
  return FINAL_STATUSES.includes(status);
};

// ── Start-time gating ────────────────────────────────────────────
// Mentor sirf is window ke andar hi Start kar sakta hai — kabhi bhi nahi.
export const START_JOIN_BEFORE_MS = 5 * 60 * 1000;  // 5 min pehle se allowed
export const START_LATE_LIMIT_MS = 15 * 60 * 1000;  // 15 min baad tak hi allowed

export const getStartWindow = (scheduledAt: Date | string) => {
  const start = new Date(scheduledAt).getTime();
  return {
    windowOpensAt: start - START_JOIN_BEFORE_MS,
    windowClosesAt: start + START_LATE_LIMIT_MS,
  };
};

export const isStartAllowed = (
  scheduledAt: Date | string,
  now: number = Date.now()
): boolean => {
  const { windowOpensAt, windowClosesAt } = getStartWindow(scheduledAt);
  return now >= windowOpensAt && now <= windowClosesAt;
};