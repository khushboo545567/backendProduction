// src/jobs/birthdayAnniversaryCron.ts
//
// Daily cron job that finds users whose birthday falls on today's date
// and creates connection_birthday notifications for each of their active connections.

import cron from 'node-cron';
import logger from '@/shared/logger.util';
import User from '@/auth/models/User.model';
import Contact from '@/Profile/models/Contact.model';
import Connection from '@/connections/models/Connection';
import NotificationService from '@/notifications/services/notification.service';

class BirthdayAnniversaryCron {
  private static isRunning = false;
  private static initialized = false;

  static init(): void {
    if (this.initialized) {
      logger.warn('BirthdayAnniversaryCron.init() already called — ignoring duplicate registration');
      return;
    }
    this.initialized = true;

    // Run every day at 08:00 AM Asia/Kolkata time
    cron.schedule(
      '0 8 * * *',
      async () => {
        if (this.isRunning) {
          logger.warn('Birthday cron skipped — previous run still in progress');
          return;
        }
        this.isRunning = true;
        try {
          logger.info('Running daily connection birthday cron job');
          await this.runDigest();

          logger.info('Daily connection birthday cron job completed');
        } catch (error) {
          logger.error('Error in connection birthday cron job', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } finally {
          this.isRunning = false;
        }
      },
      {
        timezone: 'Asia/Kolkata',
      }
    );

    logger.info('Connection birthday cron job initialized (08:00 Asia/Kolkata)');
  }

  /**
   * Finds today's birthday celebrants and notifies each of their active,
   * non-archived connections.
   */
  private static async runDigest(): Promise<void> {
    // 1. Determine today's date in Asia/Kolkata timezone
    const kolkataDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const [todayYear, todayMonth, todayDay] = kolkataDateStr.split('-').map(Number);

    // Leap-year check: if non-leap year and today is Feb 28, include Feb 29 birthdays
    const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    const isFeb28NonLeap = todayMonth === 2 && todayDay === 28 && !isLeapYear(todayYear);

    // 2. Query Contact collection for birthdays
    const contactQuery: any = {
      isDeleted: false,
      isArchived: false,
      'birthday.month': todayMonth,
    };

    if (isFeb28NonLeap) {
      contactQuery['birthday.day'] = { $in: [28, 29] };
    } else {
      contactQuery['birthday.day'] = todayDay;
    }

    const contacts = await Contact.find(contactQuery).select('userId').lean();
    const contactUserIds = contacts.map((c: any) => c.userId);

    // 3. Filter against User collection to ensure they are active and not deleted
    let birthdayUsers: any[] = [];
    if (contactUserIds.length > 0) {
      birthdayUsers = await User.find({
        userId: { $in: contactUserIds },
        status: 'active',
        'flags.isDeleted': false,
      })
        .select('userId')
        .lean();
    }



    logger.info('Birthday celebrants found for today', {
      date: kolkataDateStr,
      birthdayCount: birthdayUsers.length,
    });

    if (!birthdayUsers.length) {
      return;
    }

    // 4. For each celebrant, find active connections and notify them
    for (const celebrant of birthdayUsers) {
      const celebrantId = celebrant.userId;


      try {
        const connections = await Connection.find({
          $or: [{ fromUserId: celebrantId }, { toUserId: celebrantId }],
          status: 'active',
          isArchived: false,
        })
          .select('fromUserId toUserId')
          .lean();

        // Extract connection user IDs, remove duplicates and self IDs
        const recipientIds = Array.from(
          new Set(
            connections
              .map((c: any) => (c.fromUserId === celebrantId ? c.toUserId : c.fromUserId))
              .filter((id: string) => id && id !== celebrantId)
          )
        );

        if (!recipientIds.length) continue;

        await NotificationService.notifyConnectionBirthdaysBatch(celebrantId, recipientIds);
      } catch (userError) {
        // Individual user failure should not halt the entire batch
        logger.warn('Failed to process birthday notifications for celebrant', {
          celebrantId,
          error: userError instanceof Error ? userError.message : 'Unknown error',
        });
      }
    }
  }

  /** Manual trigger for testing and admin operations */
  static async triggerManually(): Promise<void> {
    await this.runDigest();
  }
}

export default BirthdayAnniversaryCron;
