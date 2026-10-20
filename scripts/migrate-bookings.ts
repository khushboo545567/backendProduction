// scripts/migrate-bookings.ts
// Dry run : npx ts-node scripts/migrate-bookings.ts
// Apply   : npx ts-node scripts/migrate-bookings.ts --apply
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI || process.env.MONGO_URI; // apne .env ka naam yahan rakho

async function main() {
  if (!URI) throw new Error('MONGODB_URI (ya MONGO_URI) set nahi hai');
  await mongoose.connect(URI);
  const db = mongoose.connection.db!;
  const source = db.collection('sessionmentors');
  const target = db.collection('mentorship_bookings');

  const stats = { sessions: 0, fromBookings: 0, fromLegacySingle: 0, skipped: 0, written: 0 };
  const cursor = source.find({});

  for await (const s of cursor as any) {
    stats.sessions++;
    const bookings: any[] = Array.isArray(s.bookings) ? s.bookings : [];
    const docs: any[] = [];

    for (const b of bookings) {
      const menteeId = b.menteeId || b.bookedBy;
      if (!menteeId) { stats.skipped++; continue; }
      const onlyOne = bookings.length === 1; // cancellation/reschedule session-level hain, sirf ek booking ho tab copy karo

      docs.push({
        bookingId: randomUUID(),
        legacyBookingId: String(b._id),
        sessionId: s.sessionId,
        mentorId: s.mentorId,
        menteeId,
        status: b.status || 'pending',
        slotTime: b.slotTime ?? s.slotTime,
        scheduledAt: b.scheduledAt || s.scheduledAt,
        availabilityId: b.availabilityId ?? s.availabilityId,
        bookedAt: b.bookedAt || s.bookedAt || s.createdAt,
        startedAt: b.startedAt,
        pricing: b.pricing?.totalAmount ? b.pricing : s.pricing,
        payment: { ...(s.payment || {}), ...(b.payment || {}) },
        reminders: {
          m5: !!b.reminders?.m5, m15: !!b.reminders?.m15, m30: !!b.reminders?.m30,
          h1: !!b.reminders?.h1, h24: !!b.reminders?.h24,
        },
        reschedule: onlyOne
          ? { count: s.reschedule?.count || 0, lastRescheduledAt: s.reschedule?.lastRescheduledAt,
              previousDates: s.reschedule?.previousDates || [], rescheduledBy: s.reschedule?.rescheduledBy,
              reason: s.reschedule?.reason }
          : { count: 0, previousDates: [] },
        cancellation: onlyOne ? s.cancellation : undefined,
        completion: b.completion || (onlyOne ? s.completion : undefined),
        review: onlyOne ? s.review : undefined,
        createdAt: b.bookedAt || s.createdAt || new Date(),
        updatedAt: s.updatedAt || new Date(),
      });
      stats.fromBookings++;
    }

    // createSession se bane purane documents: menteeId top-level par hai, bookings[] khali
    if (bookings.length === 0 && s.menteeId && s.status !== 'available') {
      docs.push({
        bookingId: randomUUID(),
        legacyBookingId: `legacy-${s.sessionId}`,
        sessionId: s.sessionId,
        mentorId: s.mentorId,
        menteeId: s.menteeId,
        status: s.status || 'pending',
        slotTime: s.slotTime,
        scheduledAt: s.scheduledAt,
        availabilityId: s.availabilityId,
        bookedAt: s.bookedAt || s.createdAt,
        pricing: s.pricing,
        payment: s.payment || {},
        reminders: { m5: false, m15: false, m30: false, h1: false, h24: false },
        reschedule: s.reschedule || { count: 0, previousDates: [] },
        cancellation: s.cancellation,
        completion: s.completion,
        review: s.review,
        createdAt: s.createdAt || new Date(),
        updatedAt: s.updatedAt || new Date(),
      });
      stats.fromLegacySingle++;
    }

    if (APPLY) {
      for (const d of docs) {
        const res = await target.updateOne(
          { legacyBookingId: d.legacyBookingId },
          { $setOnInsert: d },
          { upsert: true }
        );
        if (res.upsertedCount) stats.written++;
      }
    }
  }

  console.log(APPLY ? 'APPLIED' : 'DRY RUN (kuch likha nahi gaya)', stats);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });