import cron from 'node-cron';
import { LoggerUtil as logger } from '@/shared/logger.util';
import PymkNotificationState from '@/notifications/models/PymkNotificationState.model';
// NOTE: getSuggestionCards is imported dynamically inside runBatch() to break the
// circular dependency (network.service -> connection.service -> connections/routes/index).
import NotificationService from '@/notifications/services/notification.service';
import { FilterQuery, Types } from 'mongoose';
import User, { IUser } from '@/auth/models/User.model';

const PER_CALL_TIMEOUT_MS = 15000;
const BATCH_MAX_RUNTIME_MS = 5 * 60 * 1000;
const BATCH_SIZE = 100;
const MAX_CONSECUTIVE_FAILURES = 5;
const MIN_NEW_SUGGESTIONS = 3;
const NOTIFY_COOLDOWN_DAYS = 7;

// Weekly, Monday 10:00. Override with PYMK_CRON_SCHEDULE / PYMK_CRON_TZ if needed.
const SCHEDULE = process.env.PYMK_CRON_SCHEDULE || '0 10 * * 1';
const TIMEZONE = process.env.PYMK_CRON_TZ || 'Asia/Kolkata';

interface StopSignal {
  stopped: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

class PymkSuggestionCron {
  private static isRunning = false;
  private static initialized = false;

  static init(): void {
    if (this.initialized) {
      logger.warn('PymkSuggestionCron.init() called more than once, ignoring duplicate registration');
      return;
    }
    this.initialized = true;

    if (!cron.validate(SCHEDULE)) {
      logger.error('PYMK cron not registered: invalid schedule', { schedule: SCHEDULE });
      return;
    }

    cron.schedule(SCHEDULE, () => {
      void this.execute();
    }, { timezone: TIMEZONE });

    logger.warn('PYMK cron registered', { schedule: SCHEDULE, timezone: TIMEZONE });
  }

  /** Guarded entry point. Also usable for a manual trigger (e.g. triggerCron.ts). */
  static async execute(): Promise<void> {
    if (this.isRunning) {
      logger.warn('PYMK cron skipped, previous run still in progress');
      return;
    }
    this.isRunning = true;

    const stopSignal: StopSignal = { stopped: false };
    let deadlineTimer: NodeJS.Timeout | undefined;

    // Hard deadline: execute() ALWAYS returns (and releases the lock) after the max
    // runtime, even if some awaited call inside the batch never settles.
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        stopSignal.stopped = true;
        reject(new Error(`PYMK batch exceeded max runtime (${BATCH_MAX_RUNTIME_MS}ms)`));
      }, BATCH_MAX_RUNTIME_MS);
    });

    try {
      logger.warn('PYMK cron run started');
      const batch = this.runBatch(stopSignal);
      batch.catch(() => undefined); // avoid unhandled rejection if the deadline wins the race
      await Promise.race([batch, deadline]);
    } catch (error) {
      logger.error('Error in PYMK suggestion cron job', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.isRunning = false;
    }
  }

  private static async runBatch(stopSignal: StopSignal): Promise<void> {
    const { getSuggestionCards } = await withTimeout(
      import('@/connections/services/network.service'),
      PER_CALL_TIMEOUT_MS,
      'import network.service'
    );

    let lastId: Types.ObjectId | null = null;
    let processedCount = 0;
    let notifiedCount = 0;
    let failedCount = 0;
    let consecutiveFailures = 0;

    while (!stopSignal.stopped) {
      const query: FilterQuery<IUser> = lastId ? { _id: { $gt: lastId } } : {};

      const users: Array<Pick<IUser, '_id' | 'userId'>> = await User.find(query)
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .select('_id userId')
        .maxTimeMS(PER_CALL_TIMEOUT_MS)
        .lean();

      if (!users || users.length === 0) break;

      // One query per batch instead of one per user.
      const states: any[] = await PymkNotificationState.find({
        userId: { $in: users.map((u) => u.userId) },
      })
        .maxTimeMS(PER_CALL_TIMEOUT_MS)
        .lean();
      const stateMap = new Map<string, any>(states.map((s) => [String(s.userId), s]));

      for (const user of users) {
        if (stopSignal.stopped) break;

        try {
          const state = stateMap.get(String(user.userId));

          if (state?.lastNotifiedAt) {
            const daysSinceLast = (Date.now() - new Date(state.lastNotifiedAt).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceLast < NOTIFY_COOLDOWN_DAYS) continue;
          }

          // Fetch top 10 suggestions
          const suggestions = await withTimeout(
            getSuggestionCards(user.userId, 10),
            PER_CALL_TIMEOUT_MS,
            'getSuggestionCards'
          );
          consecutiveFailures = 0;

          if (!suggestions || suggestions.length === 0) continue;

          const notifiedSet = new Set(state?.notifiedSuggestionIds || []);
          const newSuggestions = suggestions.filter((s: any) => !notifiedSet.has(s.id));

          if (newSuggestions.length >= MIN_NEW_SUGGESTIONS) {
            await withTimeout(
              NotificationService.notifyPymk(user.userId, newSuggestions),
              PER_CALL_TIMEOUT_MS,
              'NotificationService.notifyPymk'
            );

            const newIds = newSuggestions.map((s: any) => s.id);

            await withTimeout(
              PymkNotificationState.findOneAndUpdate(
                { userId: user.userId },
                {
                  $set: { lastNotifiedAt: new Date() },
                  $push: { notifiedSuggestionIds: { $each: newIds, $slice: -100 } },
                },
                { upsert: true }
              ),
              PER_CALL_TIMEOUT_MS,
              'PymkNotificationState.findOneAndUpdate'
            );

            notifiedCount++;
          }
        } catch (err) {
          failedCount++;
          consecutiveFailures++;
          logger.error('PYMK cron failed for user', {
            userId: user.userId,
            error: err instanceof Error ? err.message : 'unknown',
          });

          // Dependency is probably down (Neo4j / Redis / Mongo). Stop instead of
          // burning PER_CALL_TIMEOUT_MS on every remaining user.
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            stopSignal.stopped = true;
            logger.error('PYMK cron aborting: too many consecutive failures, check Neo4j/Redis/Mongo config', {
              consecutiveFailures,
            });
            break;
          }
        }
      }

      processedCount += users.length;
      lastId = users[users.length - 1]._id as Types.ObjectId;

      await new Promise((r) => setTimeout(r, 100));
    }

    // warn level on purpose: prod logs currently show only warn/error
    logger.warn(stopSignal.stopped ? 'PYMK cron batch stopped early' : 'PYMK cron batch completed', {
      processedCount,
      notifiedCount,
      failedCount,
    });
  }
}

export default PymkSuggestionCron;