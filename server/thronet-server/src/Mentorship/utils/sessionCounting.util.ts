import { SessionMentor, SeniorSession, GroupSession } from '../models';

export interface MentorSessionCounts {
  totalSessions: number;
  upcoming: number;
  completed: number;
  missedNotHeld: number;
}

/**
 * Unified counting rule for mentor sessions:
 * totalSessions = completed + upcoming + missed/not held
 * (exclude pending and cancelled; treat overdue confirmed AND overdue in_progress bookings as missed/not held)
 * Evaluated across SessionMentor, SeniorSession, and GroupSession where this user is the mentor.
 */
export async function calculateMentorSessionCounts(
  mentorIds: string[],
  now: Date = new Date()
): Promise<MentorSessionCounts> {
  let completed = 0;
  let upcoming = 0;
  let missedNotHeld = 0;

  // 1. SessionMentor 1:1 bookings
  const smDocs = await SessionMentor.find(
    { mentorId: { $in: mentorIds } },
    { bookings: 1, scheduledAt: 1, duration: 1 }
  ).lean();

  for (const doc of smDocs as any[]) {
    if (Array.isArray(doc.bookings)) {
      for (const b of doc.bookings) {
        const status = b.status;
        if (!status || ['cancelled', 'refunded', 'rejected', 'pending'].includes(status)) continue;
        const start = new Date(b.scheduledAt || doc.scheduledAt || 0);
        const dur = Number(b.duration || b.slotDuration || doc.duration || 60);
        const end = b.endTime ? new Date(b.endTime) : new Date(start.getTime() + dur * 60000);

        if (status === 'completed') {
          completed++;
        } else if (['missed', 'not_held', 'no_show'].includes(status)) {
          missedNotHeld++;
        } else if (['confirmed', 'in_progress', 'rescheduled'].includes(status)) {
          if (end < now) {
            missedNotHeld++;
          } else {
            upcoming++;
          }
        }
      }
    }
  }

  // 2. SeniorSession bookings (including bookings inside cancelled containers like "oops")
  const ssDocs = await SeniorSession.find(
    { mentorId: { $in: mentorIds } },
    { bookings: 1, scheduledAt: 1, duration: 1 }
  ).lean();

  for (const doc of ssDocs as any[]) {
    if (Array.isArray(doc.bookings)) {
      for (const b of doc.bookings) {
        const status = b.status;
        if (!status || ['cancelled', 'refunded', 'rejected', 'pending'].includes(status)) continue;
        const start = new Date(b.scheduledAt || doc.scheduledAt || 0);
        const dur = Number(b.duration || doc.duration || 60);
        const end = b.endTime ? new Date(b.endTime) : new Date(start.getTime() + dur * 60000);

        if (status === 'completed') {
          completed++;
        } else if (['missed', 'not_held', 'no_show'].includes(status)) {
          missedNotHeld++;
        } else if (['confirmed', 'in_progress', 'rescheduled', 'upcoming'].includes(status)) {
          if (end < now) {
            missedNotHeld++;
          } else {
            upcoming++;
          }
        }
      }
    }
  }

  // 3. GroupSession events
  const gsDocs = await GroupSession.find(
    { mentorId: { $in: mentorIds } },
    { status: 1, scheduledAt: 1, duration: 1 }
  ).lean();

  for (const doc of gsDocs as any[]) {
    const status = doc.status;
    if (!status || ['cancelled', 'draft'].includes(status)) continue;
    const start = new Date(doc.scheduledAt || 0);
    const dur = Number(doc.duration || 60);
    const end = new Date(start.getTime() + dur * 60000);

    if (status === 'completed') {
      completed++;
    } else if (['missed', 'not_held'].includes(status)) {
      missedNotHeld++;
    } else if (['open', 'full', 'rescheduled', 'in_progress'].includes(status)) {
      if (end < now) {
        missedNotHeld++;
      } else {
        upcoming++;
      }
    }
  }

  const totalSessions = completed + upcoming + missedNotHeld;
  return { totalSessions, upcoming, completed, missedNotHeld };
}
