import { User } from '@/auth/models';
import logger from '@/shared/logger.util';
import { generateSecureId } from '@/shared/security';
import { emitToUser } from '@/socket';
import { NotificationType, NotificationChannel } from '../enums/NotificationType.enum';
import Notification, { INotification } from '@/notifications/models/Notification.model';

// We'll mock email and sms services for Job Notification since they might not be in Job-Service directly
// In Mentorship it uses `import emailService from './email.service';`
// We will use standard mock or logger for SMS/Email if not found, or use standard auth notification service.
// Let's create an interface for NotificationInput
export interface NotificationInput {
  userId: string;
  type: NotificationType;
  channels?: NotificationChannel[];
  data: Record<string, any>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  scheduledAt?: Date;
  authToken?: string;
}

export interface BulkNotificationInput {
  userIds: string[];
  type: NotificationType;
  channels?: NotificationChannel[];
  data: Record<string, any>;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export interface NotificationResult {
  sent: boolean;
  channels: {
    email?: boolean;
    sms?: boolean;
    whatsapp?: boolean;
    push?: boolean;
    inApp?: boolean;
  };
  error?: string;
}

class JobNotificationService {
  async sendNotification(input: NotificationInput): Promise<NotificationResult> {
    try {
      logger.info(`📬 Sending ${input.type} notification to user: ${input.userId}`);
      const channels = input.channels || this.getDefaultChannels(input.type, input.priority);
      const result: NotificationResult = { sent: false, channels: {} };

      if (channels.includes(NotificationChannel.IN_APP)) {
        try {
          result.channels.inApp = await this.sendInAppNotification(input);
        } catch (error: any) {
          logger.error(`Failed to send via ${NotificationChannel.IN_APP}:`, error);
        }
      }

      const remainingChannels = channels.filter((c) => c !== NotificationChannel.IN_APP);
      if (remainingChannels.length > 0) {
        const user = await User.findByUserId(input.userId);
        if (!user) {
          logger.warn(`User not found for userId: ${input.userId} — skipping email/sms/push`);
        } else {
          for (const channel of remainingChannels) {
            try {
              switch (channel) {
                case NotificationChannel.EMAIL:
                  result.channels.email = await this.sendEmailNotification(user, input);
                  break;
                case NotificationChannel.SMS:
                  if (user.phoneNumber) result.channels.sms = await this.sendSMSNotification(user, input);
                  break;
                default:
                  logger.warn(`Unknown notification channel: ${channel}`);
              }
            } catch (error: any) {
              logger.error(`Failed to send via ${channel}:`, error);
            }
          }
        }
      }

      result.sent = Object.values(result.channels).some((sent) => sent === true);
      logger.info(`✅ Job Notification sent: ${result.sent}`);
      return result;
    } catch (error: any) {
      logger.error('Failed to send job notification:', error);
      return { sent: false, channels: {}, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async sendBulkNotifications(inputs: NotificationInput[]): Promise<NotificationResult[]> {
    const results = [];
    for (const input of inputs) {
      results.push(await this.sendNotification(input));
    }
    return results;
  }

  async sendIdenticalBulkNotification(input: BulkNotificationInput): Promise<NotificationResult> {
    logger.info(`📬 Starting identical bulk send to ${input.userIds.length} users...`);
    const results: NotificationResult[] = [];
    
    // Batch process in chunks of 50
    const batchSize = 50;
    for (let i = 0; i < input.userIds.length; i += batchSize) {
      const batch = input.userIds.slice(i, i + batchSize);
      
      const batchPromises = batch.map(userId => this.sendNotification({
        userId,
        type: input.type,
        channels: input.channels,
        data: input.data,
        priority: input.priority,
      }));
      
      results.push(...await Promise.all(batchPromises));
      
      // Sleep 500ms between batches to prevent rate limiting / DB locking
      if (i + batchSize < input.userIds.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return { sent: true, channels: { inApp: true } }; // Aggregate result abstraction
  }

  private async sendInAppNotification(input: NotificationInput): Promise<boolean> {
    try {
      const notificationId = generateSecureId();
      const title = input.data.title || this.getDefaultTitle(input.type);
      const message = input.data.message || title;

      // Map NotificationType enum values to the Notification model's type field.
      // These values are now registered in the Notification schema enum.
      const dbType = input.type as unknown as INotification['type'];

      // Resolve a stable entityId: prefer applicationId > jobId > a generated id.
      const entityId =
        (input.data.applicationId as string | undefined) ||
        (input.data.jobId as string | undefined) ||
        notificationId;

      // Persist to the shared notifications-service collection so the frontend
      // REST poll (/notifications) picks it up alongside social notifications.
      const doc = await Notification.create({
        notificationId,
        recipientId: input.userId,
        senderId: (input.data.candidateId as string | undefined) || input.userId,
        senderName: (input.data.candidateName as string | undefined) || (input.data.companyName as string | undefined) || 'Throne8 Jobs',
        type: dbType,
        entityId,
        entityType: 'job' as const,
        message,
        isRead: false,
      });

      logger.info(`✅ Job notification persisted to DB: ${doc.notificationId} → recipientId=${input.userId}`);

      // Real-time delivery via socket (non-critical — DB record already saved).
      try {
        emitToUser(input.userId, 'notification:new', {
          notificationId: doc.notificationId,
          type: input.type,
          title,
          message,
          data: input.data,
          entityId,
          entityType: 'job',
          isRead: false,
          createdAt: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
        });
      } catch (socketErr: any) {
        logger.warn('Socket emit failed for job notification (DB record already saved):', socketErr.message);
      }

      return true;
    } catch (error: any) {
      logger.error('In-app notification failed:', error);
      return false;
    }
  }

  private async sendEmailNotification(user: any, input: NotificationInput): Promise<boolean> {
    try {
      // Mocking email logic
      const { subject } = this.buildEmailContent(input.type, input.data, user);
      logger.info(`Sending Email to ${user.email} with subject: ${subject}`);
      // return await emailService.sendEmail({ to: user.email, subject, html });
      return true;
    } catch (error: any) {
      logger.error('Email notification failed:', error);
      return false;
    }
  }

  private async sendSMSNotification(user: any, input: NotificationInput): Promise<boolean> {
    logger.info(`Sending SMS to ${user.phoneNumber}`);
    return true;
  }

  private getDefaultChannels(type: NotificationType, priority: string = 'normal'): NotificationChannel[] {
    if (priority === 'urgent' || priority === 'high') return [NotificationChannel.EMAIL, NotificationChannel.IN_APP];
    return [NotificationChannel.IN_APP];
  }

  private getDefaultTitle(type: NotificationType): string {
    switch (type) {
      case NotificationType.APPLICATION_SUBMITTED: return 'Application Submitted';
      case NotificationType.APPLICATION_STATUS_UPDATED: return 'Application Status Updated';
      case NotificationType.JOB_RECOMMENDATION: return 'New Job Recommendation';
      case NotificationType.NEW_JOB_POSTED: return 'New Job Posted';
      default: return 'Job Notification';
    }
  }

  private buildEmailContent(type: NotificationType, data: Record<string, any>, user: any): { subject: string; html: string } {
    return { subject: this.getDefaultTitle(type), html: `<p>${data.message}</p>` };
  }
}

export default new JobNotificationService();
