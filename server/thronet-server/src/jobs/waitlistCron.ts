import cron from 'node-cron';
import { logger } from '@/shared/logger.util';
import { SessionMentor } from '@/Mentorship/models';
import waitlistService from '@/Mentorship/services/waitlist.service';

class WaitlistCron {
  private running = false;

  /** Register once, in the same place you start your other crons. */
  init(): void {
    cron.schedule('*/15 * * * *', async () => {
      if (this.running) return;
      this.running = true;
      try {
        await waitlistService.expireOldEntries();
      } catch (error: any) {
        logger.error('❌ Waitlist expiry job failed:', error);
      } finally {
        this.running = false;
      }
    });
    logger.info('✅ Waitlist expiry job scheduled (every 15 minutes)');
  }

  /**
   * Call this when a booking on a session is cancelled.
   * Offers the freed slot to the next person waiting for that service.
   */
  async notifyWaitlistForSession(sessionId: string): Promise<number> {
    try {
      const session: any = await SessionMentor.findOne({ sessionId });
      if (!session) return 0;

      const notified = await waitlistService.processWaitlist(session.mentorId, session.sessionId || session.serviceId);
      return notified ? 1 : 0;
    } catch (error: any) {
      logger.error('❌ Failed to process waitlist for session cancellation:', error);
      return 0;
    }
  }
}

export default new WaitlistCron();