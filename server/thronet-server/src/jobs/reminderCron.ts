console.log('TRACE_START reminderCron.ts');
// src/jobs/reminderCron.ts
import cron from 'node-cron';
import { SessionMentor, Mentor } from '@/Mentorship/models';
import { emitToUser } from '@/socket';
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
  private static async send24HourReminders(): Promise<void> {
    try {
      const now = new Date();
      const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const in24HoursPlus15Min = new Date(in24Hours.getTime() + 15 * 60 * 1000);

      // Find sessions starting in 24 hours (with 15-min window)
      const sessions = await SessionMentor.find({
        scheduledAt: {
          $gte: in24Hours,
          $lt: in24HoursPlus15Min,
        },
        status: BookingStatus.CONFIRMED,
      });

      logger.info(`ðŸ“§ Sending 24-hour reminders for ${sessions.length} sessions`);

      for (const session of sessions) {
        try {
          // Get user and mentor details
          const [user, mentor] = await Promise.all([
            User.findByUserId(session.menteeId),
            User.findByUserId(session.mentorId),
          ]);

          if(!user || !mentor) throw new NotFoundError("user and mentor not found")

          // Send email
          await emailService.sendEmail({
            to: user.email,
            subject: 'ðŸ“… Session Reminder - Tomorrow',
            html: `
              <h2>Your session is tomorrow!</h2>
              <p>Hi ${user.fullName || user.email},</p>
              <p>This is a reminder that you have a session scheduled with <strong>${mentor.fullName || mentor.email}</strong> tomorrow.</p>
              <p><strong>Session Details:</strong></p>
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
          // ✅ NEW: in-app reminder for both mentee and mentor
          NotificationService.sendNotification({
            userId: user.userId,
            type: NotificationType.SESSION_REMINDER,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'Session Tomorrow',
              message: `Your session with ${mentor.fullName || mentor.email} is scheduled for tomorrow.`,
            },
          }).catch((e) => logger.error('In-app reminder failed (24h → mentee):', e));

          NotificationService.sendNotification({
            userId: mentor.userId,
            type: NotificationType.SESSION_REMINDER,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'Session Tomorrow',
              message: `Your session with ${user.fullName || user.email} is scheduled for tomorrow.`,
            },
          }).catch((e) => logger.error('In-app reminder failed (24h → mentor):', e));

          logger.info(`âœ… 24-hour reminder sent for session: ${session._id}`);
        } catch(error : any) {
          logger.error(`Failed to send 24-hour reminder for session ${session._id}:`, error);
        }
      }
    } catch(error : any) {
      logger.error('Error sending 24-hour reminders:', error);
    }
  }

  /**
   * Send 1-hour reminders (Email + SMS)
   */
  private static async send1HourReminders(): Promise<void> {
    try {
      const now = new Date();
      const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);
      const in1HourPlus15Min = new Date(in1Hour.getTime() + 15 * 60 * 1000);

      // Find sessions starting in 1 hour (with 15-min window)
      const sessions = await SessionMentor.find({
        scheduledAt: {
          $gte: in1Hour,
          $lt: in1HourPlus15Min,
        },
        status: BookingStatus.CONFIRMED,
      });

      logger.info(`ðŸ“§ Sending 1-hour reminders for ${sessions.length} sessions`);

      for (const session of sessions) {
        try {
          // Get user and mentor details
          const [user, mentor] = await Promise.all([
            User.findByUserId(session.menteeId),
            User.findByUserId(session.mentorId),
          ]);

          if(!user || !mentor) throw new NotFoundError("user and mentor not found")

          // Send email
          await emailService.sendEmail({
            to: user.email,
            subject: 'â° Session Starting in 1 Hour!',
            html: `
              <h2>Your session starts in 1 hour!</h2>
              <p>Hi ${user.fullName || user.email},</p>
              <p>Your session with <strong>${mentor.fullName || mentor.email}</strong> starts in 1 hour.</p>
              <p><strong>Session Details:</strong></p>
              <ul>
                <li>Type: ${session.sessionType}</li>
                <li>Time: ${session.scheduledAt.toLocaleTimeString()}</li>
                <li>Duration: ${session.duration} minutes</li>
              </ul>
              ${session.meeting?.meetingUrl ? `<p><strong>Join Meeting:</strong> <a href="${session.meeting.meetingUrl}">${session.meeting.meetingUrl}</a></p>` : ''}
              <p>Get ready! ðŸš€</p>
            `,
          });

          // Send SMS if phone number available
          if (user.phoneNumber) {
            await smsService.sendSMS({
              to: user.phoneNumber,
              message: `â° Your session with ${mentor.fullName || mentor.email} starts in 1 hour! ${session.meeting?.meetingUrl ? `Join: ${session.meeting.meetingUrl}` : ''}`,
            });
          }
          // ✅ NEW: in-app reminder for both mentee and mentor
          NotificationService.sendNotification({
            userId: user.userId,
            type: NotificationType.SESSION_REMINDER,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'Session in 1 Hour',
              message: `Your session with ${mentor.fullName || mentor.email} starts in 1 hour.`,
            },
          }).catch((e) => logger.error('In-app reminder failed (1h → mentee):', e));

          NotificationService.sendNotification({
            userId: mentor.userId,
            type: NotificationType.SESSION_REMINDER,
            channels: [NotificationChannel.IN_APP],
            data: {
              title: 'Session in 1 Hour',
              message: `Your session with ${user.fullName || user.email} starts in 1 hour.`,
            },
          }).catch((e) => logger.error('In-app reminder failed (1h → mentor):', e));

          logger.info(`âœ… 1-hour reminder sent for session: ${session._id}`);
        } catch(error : any) {
          logger.error(`Failed to send 1-hour reminder for session ${session._id}:`, error);
        }
      }
    } catch(error : any) {
      logger.error('Error sending 1-hour reminders:', error);
    }
  }
  /**
   * Send 15-minute reminders (Email + SMS + Push)
   */
  private static async send15MinuteReminders(): Promise<void> {
    try {
      const now = new Date();
      const in15Min = new Date(now.getTime() + 15 * 60 * 1000);
      const in30Min = new Date(now.getTime() + 30 * 60 * 1000);

      // Find sessions starting in 15-30 minutes
      const sessions = await SessionMentor.find({
        scheduledAt: {
          $gte: in15Min,
          $lt: in30Min,
        },
        status: BookingStatus.CONFIRMED,
      });

      logger.info(`ðŸ“§ Sending 15-minute reminders for ${sessions.length} sessions`);

      for (const session of sessions) {
        try {
          // Get user and mentor details
          const [user, mentor] = await Promise.all([
            User.findByUserId(session.menteeId),
            User.findByUserId(session.mentorId),
          ]);

          if(!user || !mentor) throw new NotFoundError("user and mentor not found")

          // Send email
          await emailService.sendEmail({
            to: user.email,
            subject: 'ðŸš€ Session Starting Soon - Join Now!',
            html: `
              <h2>Your session is starting soon!</h2>
              <p>Hi ${user.fullName || user.email},</p>
              <p>Your session with <strong>${mentor.fullName || mentor.email}</strong> is starting in 15 minutes!</p>
              <p><strong>Time:</strong> ${session.scheduledAt.toLocaleTimeString()}</p>
              ${session.meeting?.meetingUrl ? `
                <p><strong>Join Now:</strong></p>
                <a href="${session.meeting.meetingUrl}" style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">
                  Join Meeting
                </a>
              ` : ''}
              <p>See you there! ðŸŽ¯</p>
            `,
          });

          // Send SMS
          if (user.phoneNumber) {
            await smsService.sendSMS({
              to: user.phoneNumber,
              message: `ðŸš€ Your session starts in 15 minutes! ${session.meeting?.meetingUrl ? `Join now: ${session.meeting.meetingUrl}` : ''}`,
            });
          }

              // ✅ NEW: in-app reminder for both mentee and mentor
              NotificationService.sendNotification({
                userId: user.userId,
                type: NotificationType.SESSION_REMINDER,
                channels: [NotificationChannel.IN_APP],
                data: {
                  title: 'Session Starting Soon',
                  message: `Your session with ${mentor.fullName || mentor.email} starts in 15 minutes.`,
                },
              }).catch((e) => logger.error('In-app reminder failed (15min → mentee):', e));
    
              NotificationService.sendNotification({
                userId: mentor.userId,
                type: NotificationType.SESSION_REMINDER,
                channels: [NotificationChannel.IN_APP],
                data: {
                  title: 'Session Starting Soon',
                  message: `Your session with ${user.fullName || user.email} starts in 15 minutes.`,
                },
              }).catch((e) => logger.error('In-app reminder failed (15min → mentor):', e));
    
              logger.info(`âœ… 15-minute reminder sent for session: ${session._id}`);
            } catch(error : any) {
              logger.error(`Failed to send 15-minute reminder for session ${session._id}:`, error);
            }
          }
        } catch(error : any) {
          logger.error('Error sending 15-minute reminders:', error);
        }
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

