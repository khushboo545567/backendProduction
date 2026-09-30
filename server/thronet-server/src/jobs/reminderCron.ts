console.log('TRACE_START reminderCron.ts');
// src/jobs/reminderCron.ts
import cron from 'node-cron';
import { SessionMentor, Mentor } from '@/Mentorship/models';
import { emitToUser } from '@/socket/emitter';
import { User } from '@/auth/models';
import { BookingStatus } from '../shared/constants/bookingStatus';
import { logger } from '@/shared/logger.util';
import { emailService, smsService } from '@/Mentorship/services';
import { NotFoundError } from '@/shared/errors/app.error';
import NotificationService, { NotificationType, NotificationChannel } from '@/Mentorship/services/notification.service';
/**
 * Send session reminders
 * Runs every 15 minutes
 */
class ReminderCron {
  /**
   * Initialize cron jobs
   */
  static init(): void {
    // ✅ NEW: har minute — 15 min / 5 min "starting soon" reminders
    cron.schedule('* * * * *', async () => {
      try {
        await this.sendStartingSoonReminders();
      } catch (error: any) {
        logger.error('Error in starting-soon reminder cron:', error);
      }
    });
    // Run every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
      try {
        logger.info('ðŸ”” Running session reminder cron job');
        await this.send24HourReminders();
        await this.send1HourReminders();
        await this.send15MinuteReminders();
        logger.info('âœ… Session reminder cron job completed');
      } catch(error : any) {
        logger.error('âŒ Error in reminder cron job:', error);
      }
    });

    logger.info('ðŸ”” Reminder cron job initialized');
  }

  /**
   * Send 24-hour reminders
   */
    /**
   * Generic helper — 24h / 1h / 30min reminders sabke liye same shape.
   * window: kitne minute pehle se reminder bhejna hai (from, to)
   * flagKey: bookings[].reminders ke andar kaunsa flag
   */
  private static async sendWindowReminder(opts: {
    fromMin: number;
    toMin: number;
    flagKey: 'h24' | 'h1' | 'm30';
    label: string;
    sendSms: boolean;
    subject: string;
    buildHtml: (user: any, mentor: any, session: any) => string;
    smsText?: (user: any, mentor: any, session: any) => string;
  }): Promise<void> {
    try {
      const now = new Date();
      const from = new Date(now.getTime() + opts.fromMin * 60 * 1000);
      const to = new Date(now.getTime() + opts.toMin * 60 * 1000);
      const flagPath = `reminders.${opts.flagKey}`;
      const liveStatuses = [BookingStatus.CONFIRMED, BookingStatus.RESCHEDULED];

      // ✅ FIX: root-level fields ke bajay bookings[] pe query
      const sessions = await SessionMentor.find({
        bookings: {
          $elemMatch: {
            status: { $in: liveStatuses },
            scheduledAt: { $gte: from, $lt: to },
            [flagPath]: { $ne: true },
          },
        },
      } as any);

      logger.info(`📧 Sending ${opts.label} reminders for ${sessions.length} session(s)`);

      for (const session of sessions) {
        // ✅ FIX: mentorId → Mentor doc → uska userId
        const mentorDoc: any = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });
        const mentor: any = mentorDoc?.userId ? await User.findByUserId(mentorDoc.userId) : null;

        for (const booking of ((session.bookings ?? []) as any[])) {
          try {
            if (!liveStatuses.includes(booking.status)) continue;
            const startAt = booking.scheduledAt ? new Date(booking.scheduledAt) : null;
            if (!startAt || startAt < from || startAt >= to) continue;
            if (booking.reminders?.[opts.flagKey]) continue;

            // ✅ FIX: booking-level menteeId, root-level nahi
            const menteeId: string | undefined = booking.menteeId || booking.bookedBy;
            const user: any = menteeId ? await User.findByUserId(menteeId) : null;

            if (!user || !mentor) {
              logger.warn(`Skipping ${opts.label} reminder: user or mentor not found`, {
                sessionId: session.sessionId,
                bookingId: String(booking._id),
                menteeId,
                mentorId: session.mentorId,
              });
              continue;
            }

            // ✅ FIX: atomic claim — sirf ek hi run/instance isko claim karega
            const claim = await SessionMentor.updateOne(
              {
                sessionId: session.sessionId,
                bookings: { $elemMatch: { _id: booking._id, [flagPath]: { $ne: true } } },
              } as any,
              { $set: { [`bookings.$.${flagPath}`]: true } } as any
            );
            if (claim.modifiedCount === 0) continue; // kisi aur run ne pehle claim kar liya

            await emailService.sendEmail({
              to: user.email,
              subject: opts.subject,
              html: opts.buildHtml(user, mentor, session),
            });

            if (opts.sendSms && user.phoneNumber && opts.smsText) {
              await smsService.sendSMS({
                to: user.phoneNumber,
                message: opts.smsText(user, mentor, session),
              });
            }

            NotificationService.sendNotification({
              userId: user.userId,
              type: NotificationType.SESSION_REMINDER,
              channels: [NotificationChannel.IN_APP],
              data: {
                title: opts.label,
                message: `Your session with ${mentor.fullName || mentor.email} — ${opts.label.toLowerCase()}.`,
              },
            }).catch((e) => logger.error(`In-app reminder failed (${opts.flagKey} → mentee):`, e));

            NotificationService.sendNotification({
              userId: mentor.userId,
              type: NotificationType.SESSION_REMINDER,
              channels: [NotificationChannel.IN_APP],
              data: {
                menteeId: user.userId,
                menteeName: user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
                menteePhoto: (user as any).profilePhotoUrl || (user as any).profilePhoto || (user as any).avatar || null,
                title: opts.label,
                message: `Your session "${session.title || 'Session'}" with ${user.fullName || user.email} ${opts.label.toLowerCase()}. Start it when you are ready.`,
              },
            }).catch((e) => logger.error(`In-app reminder failed (${opts.flagKey} → mentor):`, e));

            logger.info(`✅ ${opts.label} reminder sent — session ${session.sessionId} / booking ${booking._id}`);
          } catch (error: any) {
            logger.error(`Failed ${opts.label} reminder for booking ${booking._id}:`, error);
          }
        }
      }
    } catch (error: any) {
      logger.error(`Error sending ${opts.label} reminders:`, error);
    }
  }

  private static async send24HourReminders(): Promise<void> {
    await this.sendWindowReminder({
      fromMin: 24 * 60,
      toMin: 24 * 60 + 15,
      flagKey: 'h24',
      label: 'Session Tomorrow',
      sendSms: false,
      subject: '📅 Session Reminder - Tomorrow',
      buildHtml: (user, mentor, session) => `
        <h2>Your session is tomorrow!</h2>
        <p>Hi ${user.fullName || user.email},</p>
        <p>This is a reminder that you have a session scheduled with <strong>${mentor.fullName || mentor.email}</strong> tomorrow.</p>
        <ul>
          <li>Type: ${session.sessionType}</li>
          <li>Date: ${session.scheduledAt.toLocaleDateString()}</li>
          <li>Time: ${session.scheduledAt.toLocaleTimeString()}</li>
          <li>Duration: ${session.duration} minutes</li>
        </ul>
        ${session.meeting?.meetingUrl ? `<p><strong>Meeting Link:</strong> <a href="${session.meeting.meetingUrl}">${session.meeting.meetingUrl}</a></p>` : ''}
        <p>Need to reschedule? Contact your mentor.</p>
      `,
    });
  }

  private static async send1HourReminders(): Promise<void> {
    await this.sendWindowReminder({
      fromMin: 60,
      toMin: 75,
      flagKey: 'h1',
      label: 'Session in 1 Hour',
      sendSms: true,
      subject: '⏰ Session Starting in 1 Hour!',
      buildHtml: (user, mentor, session) => `
        <h2>Your session starts in 1 hour!</h2>
        <p>Hi ${user.fullName || user.email},</p>
        <p>Your session with <strong>${mentor.fullName || mentor.email}</strong> starts in 1 hour.</p>
        <ul>
          <li>Type: ${session.sessionType}</li>
          <li>Time: ${session.scheduledAt.toLocaleTimeString()}</li>
          <li>Duration: ${session.duration} minutes</li>
        </ul>
        ${session.meeting?.meetingUrl ? `<p><strong>Join Meeting:</strong> <a href="${session.meeting.meetingUrl}">${session.meeting.meetingUrl}</a></p>` : ''}
        <p>Get ready! 🚀</p>
      `,
      smsText: (user, mentor, session) =>
        `⏰ Your session with ${mentor.fullName || mentor.email} starts in 1 hour! ${session.meeting?.meetingUrl ? `Join: ${session.meeting.meetingUrl}` : ''}`,
    });
  }

  private static async send15MinuteReminders(): Promise<void> {
    await this.sendWindowReminder({
      fromMin: 15,
      toMin: 30,
      flagKey: 'm30',
      label: 'Session Starting Soon',
      sendSms: true,
      subject: '🚀 Session Starting Soon - Join Now!',
      buildHtml: (user, mentor, session) => `
        <h2>Your session is starting soon!</h2>
        <p>Hi ${user.fullName || user.email},</p>
        <p>Your session with <strong>${mentor.fullName || mentor.email}</strong> is starting soon!</p>
        <p><strong>Time:</strong> ${session.scheduledAt.toLocaleTimeString()}</p>
        ${session.meeting?.meetingUrl ? `
          <p><strong>Join Now:</strong></p>
          <a href="${session.meeting.meetingUrl}" style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">
            Join Meeting
          </a>
        ` : ''}
        <p>See you there! 🎯</p>
      `,
      smsText: (user, mentor, session) =>
        `🚀 Your session starts soon! ${session.meeting?.meetingUrl ? `Join now: ${session.meeting.meetingUrl}` : ''}`,
    });
  }
  /**
   * Manual trigger for testing
   */


    /**
   * ✅ NEW: "Session starting soon" reminders.
   * - Booking ke apne scheduledAt pe based (template ke pe nahi)
   * - Mentor userId Mentor doc se (mentorId != userId)
   * - Atomic claim => multiple instances pe bhi duplicate nahi
   */
    private static async sendStartingSoonReminders(): Promise<void> {
      const now = new Date();
      const liveStatuses = [BookingStatus.CONFIRMED, BookingStatus.RESCHEDULED];
      // Non-overlapping windows: session 3 min door ho to sirf m5 jayega, dono nahi
      const windows = [
        { key: 'm15', fromMin: 5, toMin: 15, label: '15 minutes' },
        { key: 'm5', fromMin: 0, toMin: 5, label: '5 minutes' },
      ];
  
      for (const w of windows) {
        const from = new Date(now.getTime() + w.fromMin * 60 * 1000);
        const to = new Date(now.getTime() + w.toMin * 60 * 1000);
        const flagPath = `reminders.${w.key}`;
  
        const sessions = await SessionMentor.find({
          bookings: {
            $elemMatch: {
              status: { $in: liveStatuses },
              scheduledAt: { $gt: from, $lte: to },
              [flagPath]: { $ne: true },
            },
          },
        } as any);
  
        for (const session of sessions) {
          const mentorDoc: any = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });
          const mentorUser: any = mentorDoc?.userId ? await User.findByUserId(mentorDoc.userId) : null;
          const mentorName = mentorUser?.fullName || mentorUser?.email || mentorDoc?.title || 'your mentor';
  
          for (const booking of ((session.bookings ?? []) as any[])) {
            if (!liveStatuses.includes(booking.status)) continue;
            const startAt = booking.scheduledAt ? new Date(booking.scheduledAt) : null;
            if (!startAt || startAt <= from || startAt > to) continue;
            if (booking.reminders?.[w.key]) continue;
  
            // Atomic claim — jo pehle claim kare wahi bhejega
            const claim = await SessionMentor.updateOne(
              {
                sessionId: session.sessionId,
                bookings: { $elemMatch: { _id: booking._id, [flagPath]: { $ne: true } } },
              } as any,
              { $set: { [`bookings.$.${flagPath}`]: true } } as any
            );
            if (claim.modifiedCount === 0) continue;
  
            const menteeId: string | undefined = booking.menteeId || booking.bookedBy;
            const menteeUser: any = menteeId ? await User.findByUserId(menteeId) : null;
            const menteeName = menteeUser?.fullName || menteeUser?.email || 'your mentee';
  
            const bookingId = String(booking._id);
            const minutesLeft = Math.max(1, Math.round((startAt.getTime() - now.getTime()) / 60000));
            const base = {
              sessionId: session.sessionId,
              bookingId,
              roomId: bookingId,
              title: session.title,
              scheduledAt: startAt.toISOString(),
              minutesLeft,
            };
  
            const notify = (targetUserId: string, otherName: string, isMentee: boolean) => {
              NotificationService.sendNotification({
                userId: targetUserId,
                type: NotificationType.SESSION_REMINDER,
                channels: [NotificationChannel.IN_APP],
                priority: 'high',
                data: {
                  ...base,
                  ...(!isMentee && menteeId ? {
                    menteeId,
                    menteeName,
                    menteePhoto: (menteeUser as any)?.profilePhotoUrl || (menteeUser as any)?.profilePhoto || (menteeUser as any)?.avatar || null
                  } : {}),
                  title: `Session starts in ${w.label}`,
                  message: `Your session "${session.title}" with ${otherName} starts in ${w.label}.${
                    isMentee ? ' Be ready to join!' : ' Start it when you are ready.'
                  }`,
                },
              }).catch((e) => logger.error(`In-app reminder failed (${w.key}):`, e));
  
              try {
                emitToUser(targetUserId, 'session:reminder', { ...base, mentorName, menteeName });
              } catch (e: any) {
                logger.warn(`session:reminder emit failed: ${e?.message}`);
              }
            };
  
            if (menteeId) notify(menteeId, mentorName, true);
            if (mentorDoc?.userId) notify(mentorDoc.userId, menteeName, false);
  
            logger.info(`⏰ ${w.key} reminder sent: session ${session.sessionId} / booking ${bookingId}`);
          }
        }
      }
    }
  
    static async triggerManually(): Promise<void> {
    logger.info('ðŸ”” Manually triggering reminder cron job');
    await this.send24HourReminders();
    await this.send1HourReminders();
    await this.send15MinuteReminders();
    logger.info('âœ… Manual trigger completed');
  }
}

export default ReminderCron;
console.log('TRACE_END reminderCron.ts');

