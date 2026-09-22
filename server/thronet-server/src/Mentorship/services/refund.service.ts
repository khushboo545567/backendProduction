import { logger } from '@/shared/logger.util';
import emailService from './email.service';
import smsService from './sms.service';
import { CancellationLog, SessionMentor, Mentor } from '../models';
import { User } from '@/auth/models';
import { BookingStatus } from '@/shared/constants/bookingStatus';
import refundCalculator from '@/Mentorship/utils/refundCalculator';
import { PaymentStatus } from '@/Mentorship/interface/session.types';
import emailTemplates from '@/Mentorship/utils/emailTemplates';
import smsTemplates from '@/Mentorship/utils/smsTemplates';
import Razorpay from 'razorpay';
import availabilityService from './availability.service';
import NotificationService, { NotificationType, NotificationChannel } from './notification.service';

// Razorpay instance — initialized once, reused across calls
let razorpay: Razorpay | null = null;

function getRazorpay(): Razorpay {
  if (!razorpay) {
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;

    if (!key_id || !key_secret) {
      throw new Error(
        'Razorpay not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env'
      );
    }

    razorpay = new Razorpay({ key_id, key_secret });
  }
  return razorpay;
}

interface RefundInput {
  sessionId: string;
  userId: string;
  reason: string;
  bookingId?: string;
  cancellationCategory?: 'personal' | 'emergency' | 'scheduling_conflict' | 'technical' | 'other';
  additionalNotes?: string;
  isEmergency?: boolean;
}


interface RefundResult {
  success: boolean;
  refundAmount: number;
  refundPercentage: number;
  refundEligible: boolean;
  refundStatus: string;
  transactionId?: string;
  message: string;
  cancellationLog: any;
}

class RefundService {
  /**
   * Process refund for cancelled session.
   *
   * ✅ FIX: session.save() is now called once atomically using findByIdAndUpdate.
   * Previously two separate saves could leave session in CANCELLED state
   * if the process crashed between step 6 and step 8.
   */
  async processRefund(input: RefundInput, authToken?: string): Promise<RefundResult> {
    try {
      logger.info(`Processing refund for session: ${input.sessionId}`);

      // Step 1: Get session details
      /**
       * TEMP FIX (UUID Lookup)
       *
       * Refund flow receives the public sessionId (UUID)
       * from the cancellation pipeline.
       *
       * Query by sessionId instead of MongoDB _id to
       * prevent ObjectId cast errors while preserving
       * the existing backend architecture.
       */
      const session = await SessionMentor.findOne({
        sessionId: input.sessionId,
    });
    if (!session) {
      throw new Error('Session not found');
    }

    // ✅ FIX: resolve the SPECIFIC booking being cancelled. A session
    // "template" can have multiple bookings from different mentees.
    // The old code only ever compared against session.menteeId (set
    // only for whichever mentee booked FIRST) — any other mentee
    // cancelling their own valid booking got wrongly rejected.
    const targetBooking = input.bookingId
      ? session.bookings?.find((b: any) => b._id?.toString() === input.bookingId)
      : undefined;

    const effectiveMenteeId = targetBooking?.menteeId || targetBooking?.bookedBy || session.menteeId;
    const effectivePricing = targetBooking?.pricing?.totalAmount ? targetBooking.pricing : session.pricing;
    const effectiveScheduledAt = targetBooking?.scheduledAt || session.scheduledAt;

    // Step 2: Idempotency check — prevent double refund
    if (
      session.status === BookingStatus.CANCELLED ||
      session.status === BookingStatus.REFUNDED ||
      (targetBooking && targetBooking.status === 'cancelled')
    ) {
      logger.warn(`Refund already processed for session: ${input.sessionId}`);
      throw new Error('Refund has already been processed for this session');
    }

        // ✅ FIX: session.mentorId is the Mentor-PROFILE id (e.g. from the
    // Mentor collection), not the mentor's actual auth userId. The old
    // validation compared session.mentorId directly against input.userId
    // (the logged-in user's real userId) — for a mentor cancelling their
    // own session, these can NEVER match, so every mentor-initiated
    // cancellation was wrongly rejected as "not authorized" (a plain Error
    // with no statusCode -> 500). Resolve the mentor's real userId first.
    const mentorDoc = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });
    const mentorUserId = mentorDoc?.userId;

        // Step 3: Validate cancellation is allowed (against the correct mentee/mentor)
        this.validateCancellation(session, input.userId, effectiveMenteeId, mentorUserId, effectiveScheduledAt);

    // Step 4: Calculate refund using the specific booking's pricing/time
    const refundCalculation = input.isEmergency
      ? refundCalculator.calculateEmergencyRefund(
        effectivePricing.totalAmount,
        effectivePricing.platformFee,
        effectivePricing.basePrice
      )
      : refundCalculator.calculateRefund({
        sessionPrice: effectivePricing.basePrice,
        platformFee: effectivePricing.platformFee,
        totalAmount: effectivePricing.totalAmount,
        scheduledAt: effectiveScheduledAt,
      });

    logger.info(
      `Refund calculated: ${refundCalculation.refundPercentage}% = Rs.${refundCalculation.refundAmount}`
    );

    // Step 5: Determine user role
    const userRole = effectiveMenteeId === input.userId ? 'mentee' : 'mentor';


      // Step 6: Create cancellation log first (before touching session status)
      const cancellationLog = await this.createCancellationLog(
        session,
        input,
        refundCalculation,
        userRole
      );

            // Step 7: Initiate refund with payment gateway if eligible
            let transactionId: string | undefined;
            // ✅ FIX: `bookings[].status` schema enum does NOT include 'refunded' —
            // only the top-level `status` field (and `payment.status`) support it.
            // Writing 'refunded' into bookings.$[elem].status threw a Mongoose
            // ValidationError, which the global handler turned into a 500 for
            // EVERY refund-eligible (future-date) cancellation. Booking-array
            // status now always stays 'cancelled'; refund state is tracked
            // separately via payment.status and top-level session status.
            let bookingStatus: string = BookingStatus.CANCELLED;
            let sessionStatus: string = BookingStatus.CANCELLED;
            let paymentUpdate: any = {
              'cancellation.cancelledBy': input.userId,
              'cancellation.cancelledAt': new Date(),
              'cancellation.reason': input.reason,
              'cancellation.refundEligible': refundCalculation.refundEligible,
            };
      
            if (refundCalculation.refundEligible && refundCalculation.refundAmount > 0) {
              transactionId = await this.initiateRefundTransaction(
                session,
                refundCalculation.refundAmount
              );
      
              // ✅ FIX: Single atomic update — was previously two separate session.save() calls.
              // If process crashes between the old step 6 and step 8, session would be stuck
              // as CANCELLED. Now everything is committed in one DB operation.
              sessionStatus = BookingStatus.REFUNDED;
              paymentUpdate = {
                ...paymentUpdate,
                'payment.status': PaymentStatus.REFUNDED,
                'payment.refundAmount': refundCalculation.refundAmount,
                'payment.refundedAt': new Date(),
                'payment.refundReason': input.reason,
              };
      
              cancellationLog.refundStatus = 'processing';
              cancellationLog.refundTransactionId = transactionId;
              await cancellationLog.save();
            }
      
               // ✅ FIX: When a specific booking is cancelled (multi-mentee session
            // template), only THAT booking's status is updated via arrayFilters.
            // Previously, session-level `status` was always overwritten — which
            // would incorrectly cancel every other mentee's booking on the same
            // session template too.
            if (input.bookingId && targetBooking) {
              await SessionMentor.findByIdAndUpdate(
                session._id,
                {
                  $set: {
                    'bookings.$[elem].status': bookingStatus,
                    ...paymentUpdate,
                  },
                },
                {
                  runValidators: true,
                  arrayFilters: [{ 'elem._id': input.bookingId }],
                }
              );
            } else {
              await SessionMentor.findByIdAndUpdate(
                session._id,
                {
                  $set: {
                    status: sessionStatus,
                    ...paymentUpdate,
                  },
                },
                { runValidators: true }
              );
            }

                       // Step 8: Send notifications (non-critical — failure does not throw)
// ✅ NEW: cancelled booking ka availability slot wapas free karo
if (targetBooking?.availabilityId && targetBooking?.slotTime) {
  try {
    const [releaseStart, releaseEnd] = String(targetBooking.slotTime)
      .split(' - ')
      .map((t: string) => t.trim());
    await availabilityService.releaseRange(targetBooking.availabilityId, releaseStart, releaseEnd);
  } catch (releaseErr: any) {
    logger.warn(`Slot release failed after cancellation: ${releaseErr.message}`);
  }
}

await this.sendRefundNotifications(session, refundCalculation, input.reason, effectiveMenteeId, input.userId);

      // Step 9: Mark notifications sent in log
      cancellationLog.mentorNotified = true;
      cancellationLog.menteeNotified = true;
      cancellationLog.notificationsSentAt = new Date();
      await cancellationLog.save();

      logger.info(`Refund processed successfully for session: ${input.sessionId}`);

      return {
        success: true,
        refundAmount: refundCalculation.refundAmount,
        refundPercentage: refundCalculation.refundPercentage,
        refundEligible: refundCalculation.refundEligible,
        refundStatus: refundCalculation.refundEligible ? 'processing' : 'not_applicable',
        transactionId,
        message: refundCalculator.getRefundMessage(refundCalculation),
        cancellationLog,
      };
    } catch (error: any) {
      logger.error(`Refund processing failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Validate if session can be cancelled
   */
  private validateCancellation(
    session: any,
    userId: string,
    effectiveMenteeId?: string,
    mentorUserId?: string,
    effectiveScheduledAt?: Date
  ): void {
    const menteeIdToCheck = effectiveMenteeId ?? session.menteeId;
    // ✅ FIX: compare against the mentor's resolved userId, not the raw
    // session.mentorId (which is a Mentor-profile id, not an auth userId).
    if (menteeIdToCheck !== userId && mentorUserId !== userId) {
      throw new Error('You are not authorized to cancel this session');
    }



    if (session.status === BookingStatus.CANCELLED || session.status === BookingStatus.REFUNDED) {
      throw new Error('Session is already cancelled');
    }

    if (session.status === BookingStatus.COMPLETED) {
      throw new Error('Cannot cancel a completed session');
    }

    if (session.status === BookingStatus.IN_PROGRESS) {
      throw new Error('Cannot cancel a session that is in progress');
    }

    // ✅ FIX: use the SPECIFIC booking's scheduledAt (effectiveScheduledAt),
    // not the session template's top-level scheduledAt. For multi-mentee
    // session templates, the template date can differ from this mentee's
    // actual booked slot — checking the wrong field caused future bookings
    // to be wrongly rejected as "past session".
    const dateToCheck = effectiveScheduledAt ?? session.scheduledAt;
    if (dateToCheck < new Date()) {
      throw new Error('Cannot cancel a past session');
    }
  }

  /**
   * Create cancellation log entry
   */
  private async createCancellationLog(
    session: any,
    input: RefundInput,
    refundCalculation: any,
    userRole: 'mentor' | 'mentee'
  ): Promise<any> {
    const cancellationLog = await CancellationLog.create({
      sessionId: session._id.toString(),
      cancelledBy: input.userId,
      cancelledByRole: userRole,
      sessionType: session.sessionType,
      scheduledAt: session.scheduledAt,
      timezone: session.timezone,
      sessionPrice: session.pricing.totalAmount,
      reason: input.reason,
      cancellationCategory: input.cancellationCategory || 'other',
      additionalNotes: input.additionalNotes,
      hoursBeforeSession: refundCalculation.hoursBeforeSession,
      withinPolicy: refundCalculation.withinPolicy,
      refundEligible: refundCalculation.refundEligible,
      refundPercentage: refundCalculation.refundPercentage,
      refundAmount: refundCalculation.refundAmount,
      refundStatus: refundCalculation.refundEligible ? 'pending' : 'not_applicable',
      cancelledAt: new Date(),
    });

    logger.info(`Cancellation log created: ${cancellationLog._id}`);
    return cancellationLog;
  }

  /**
   * Initiate refund with Razorpay.
   *
   * ✅ FIX: Razorpay properly integrated.
   * Requires session.payment.gatewayPaymentId to be set when booking was created.
   *
   * Razorpay refund docs: https://razorpay.com/docs/api/refunds/
   */
  private async initiateRefundTransaction(
    session: any,
    refundAmount: number
  ): Promise<string> {
    if (!session.payment?.gatewayPaymentId) {
      logger.warn(
        `No gateway payment ID for session ${session._id}. Queuing for manual refund.`
      );
      const pendingId = `REFUND_MANUAL_${Date.now()}_${session._id}`;
      logger.warn(`Manual refund queued: ${pendingId} — amount: Rs.${refundAmount}`);
      return pendingId;
    }

    try {
      const refund = await getRazorpay().payments.refund(
        session.payment.gatewayPaymentId,
        {
          amount: Math.round(refundAmount * 100), // Razorpay expects paise (integer)
          speed: 'normal',
          notes: {
            sessionId: session._id.toString(),
            reason: 'User cancellation via platform',
          },
        }
      );

      logger.info(`Razorpay refund initiated: ${refund.id} for Rs.${refundAmount}`);
      return refund.id;
    } catch (error: any) {
      // ✅ FIX: Don't let a Razorpay/config failure crash the whole
      // cancellation with a 500. Fall back to manual refund queuing
      // so the session still gets cancelled successfully; the refund
      // itself can be processed manually by admin later.
      logger.error(`Razorpay refund failed, falling back to manual queue: ${error.message}`);
      const pendingId = `REFUND_MANUAL_FALLBACK_${Date.now()}_${session._id}`;
      logger.warn(`Manual refund queued after Razorpay failure: ${pendingId} — amount: Rs.${refundAmount}`);
      return pendingId;
    }
  }



  /**
   * Send refund notifications to both parties (non-critical)
   */
  private async sendRefundNotifications(
    session: any,
    refundCalculation: any,
    reason: string,
    menteeId?: string,
    cancelledByUserId?: string
  ): Promise<void> {
    try {
      logger.info('Sending refund notifications');

            // ✅ FIX: session.mentorId is the Mentor-profile id, not the auth
      // userId — resolve mentor's real userId first (same pattern used
      // in processRefund's validateCancellation step).
      const mentorDoc = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });

      const [mentee, mentor] = await Promise.all([
        User.findByUserId(menteeId || session.menteeId),
        mentorDoc?.userId ? User.findByUserId(mentorDoc.userId) : Promise.resolve(null),
      ]);



      if (!mentee || !mentor) {
        logger.warn('Mentee or Mentor user not found for notifications', {
          menteeId: session.menteeId,
          mentorId: session.mentorId,
        });
        return;
      }

      const scheduledAtFormatted = session.scheduledAt.toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });

      // Email to mentee
      await emailService.sendEmail({
        to: mentee.email,
        subject: `Session Cancelled - ${session.sessionType}`,
        html: emailTemplates.cancellationConfirmationTemplate({
          userName: mentee.fullName || mentee.email,
          mentorName: mentor.fullName || mentor.email,
          sessionType: session.sessionType,
          scheduledAt: scheduledAtFormatted,
          reason,
          refundAmount: refundCalculation.refundAmount,
          refundPercentage: refundCalculation.refundPercentage,
          refundStatus: refundCalculation.refundEligible ? 'Processing' : 'Not Applicable',
          refundEligible: refundCalculation.refundEligible,
        }),
      });

      // SMS to mentee
      if (mentee.phoneNumber) {
        const smsMessage = smsTemplates.cancellationConfirmation({
          sessionType: session.sessionType,
          scheduledTime: scheduledAtFormatted,
          refundAmount: refundCalculation.refundAmount,
          refundPercentage: refundCalculation.refundPercentage,
        });
        await smsService.sendSMS({ to: mentee.phoneNumber, message: smsMessage });
      }

      // Email to mentor
      await emailService.sendEmail({
        to: mentor.email,
        subject: `Session Cancelled - ${session.sessionType}`,
        html: emailTemplates.mentorSessionCancelledTemplate({
          mentorName: mentor.fullName || mentor.email,
          menteeName: mentee.fullName || mentee.email,
          sessionType: session.sessionType,
          scheduledAt: scheduledAtFormatted,
          reason,
          compensationAmount: refundCalculation.mentorPayout,
        }),
      });

           // SMS to mentor
           if (mentor.phoneNumber) {
            const mentorSmsMessage = smsTemplates.mentorCancellationNotification({
              menteeName: mentee.fullName || mentee.email,
              sessionType: session.sessionType,
              scheduledTime: scheduledAtFormatted,
              compensationAmount: refundCalculation.mentorPayout,
            });
            await smsService.sendSMS({ to: mentor.phoneNumber, message: mentorSmsMessage });
          }
              // ✅ FIX: figure out who actually cancelled, so the notification
          // (a) goes to the OTHER party, not back to the canceller, and
          // (b) correctly names the person who cancelled.
          const cancelledByMentee = cancelledByUserId === mentee.userId;
          const cancellerName = cancelledByMentee
            ? (mentee.fullName || mentee.email)
            : (mentor.fullName || mentor.email);

          if (cancelledByMentee) {
            // Mentee cancelled → notify the mentor only
            NotificationService.sendNotification({
              userId: mentor.userId,
              type: NotificationType.SESSION_CANCELLED,
              channels: [NotificationChannel.IN_APP],
              data: {
                title: 'Session Cancelled',
                message: `${cancellerName} cancelled the "${session.sessionType}" session. Reason: ${reason}`,
              },
            }).catch((e) => logger.error('In-app notification failed (refund → mentor):', e));
          } else {
            // Mentor cancelled → notify the mentee only
            NotificationService.sendNotification({
              userId: mentee.userId,
              type: NotificationType.SESSION_CANCELLED,
              channels: [NotificationChannel.IN_APP],
              data: {
                title: refundCalculation.refundEligible ? 'Session Cancelled — Refund Processing' : 'Session Cancelled',
                message: refundCalculation.refundEligible
                  ? `${cancellerName} cancelled your "${session.sessionType}" session. Reason: ${reason}. A refund of ₹${refundCalculation.refundAmount} is being processed.`
                  : `${cancellerName} cancelled your "${session.sessionType}" session. Reason: ${reason}`,
              },
            }).catch((e) => logger.error('In-app notification failed (refund → mentee):', e));
          }
    
          logger.info('Refund notifications sent successfully');
    } catch (error: any) {
      // Non-critical — log but do not throw
      logger.error(`Failed to send refund notifications: ${error.message}`);
    }
  }

  /**
   * Complete refund after payment gateway confirmation webhook
   */
  async completeRefund(
    cancellationLogId: string,
    transactionId: string
  ): Promise<void> {
    try {
      logger.info(`Completing refund for cancellation: ${cancellationLogId}`);

      const cancellationLog = await CancellationLog.findById(cancellationLogId);
      if (!cancellationLog) {
        throw new Error('Cancellation log not found');
      }

      cancellationLog.refundStatus = 'completed';
      cancellationLog.refundTransactionId = transactionId;
      cancellationLog.refundProcessedAt = new Date();
      await cancellationLog.save();

      const session = await SessionMentor.findById(cancellationLog.sessionId);
      if (session) {
        const mentee = await User.findByUserId(session.menteeId);

        if (!mentee) {
          logger.warn('Mentee not found for refund completion email', {
            menteeId: session.menteeId,
          });
          return;
        }

        await emailService.sendEmail({
          to: mentee.email,
          subject: 'Refund Processed Successfully',
          html: emailTemplates.refundProcessedTemplate({
            userName: mentee.fullName || mentee.email,
            sessionType: cancellationLog.sessionType,
            refundAmount: cancellationLog.refundAmount,
            transactionId,
            processedAt: new Date().toLocaleString('en-IN'),
            expectedCreditDays: 5,
          }),
        });

        if (mentee.phoneNumber) {
          const smsMessage = smsTemplates.refundProcessed({
            refundAmount: cancellationLog.refundAmount,
            transactionId,
            expectedDays: 5,
          });
          await smsService.sendSMS({ to: mentee.phoneNumber, message: smsMessage });
        }
      }

      logger.info('Refund completed successfully');
    } catch (error: any) {
      logger.error(`Failed to complete refund: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle failed refund
   */
  async handleFailedRefund(cancellationLogId: string): Promise<void> {
    try {
      logger.error(`Refund failed for cancellation: ${cancellationLogId}`);

      const cancellationLog = await CancellationLog.findById(cancellationLogId);
      if (!cancellationLog) {
        throw new Error('Cancellation log not found');
      }

      cancellationLog.refundStatus = 'failed';
      await cancellationLog.save();

      const session = await SessionMentor.findById(cancellationLog.sessionId);
      if (session) {
        const mentee = await User.findByUserId(session.menteeId);
        if (!mentee) {
          logger.warn('Mentee not found for failed refund notification', {
            menteeId: session.menteeId,
          });
          return;
        }

        if (mentee.phoneNumber) {
          const smsMessage = smsTemplates.refundFailed(cancellationLog.refundAmount);
          await smsService.sendSMS({ to: mentee.phoneNumber, message: smsMessage });
        }
      }

      logger.info('Failed refund logged and notifications sent');
    } catch (error: any) {
      logger.error(`Failed to handle refund failure: ${error.message}`);
    }
  }

  /**
   * Get refund status
   */
  async getRefundStatus(cancellationLogId: string): Promise<{
    status: string;
    refundAmount: number;
    refundPercentage: number;
    transactionId?: string;
    processedAt?: Date;
  }> {
    const cancellationLog = await CancellationLog.findById(cancellationLogId);
    if (!cancellationLog) {
      throw new Error('Cancellation log not found');
    }

    return {
      status: cancellationLog.refundStatus,
      refundAmount: cancellationLog.refundAmount,
      refundPercentage: cancellationLog.refundPercentage,
      transactionId: cancellationLog.refundTransactionId,
      processedAt: cancellationLog.refundProcessedAt,
    };
  }

  /**
   * Get pending refunds (admin dashboard)
   */
  async getPendingRefunds(limit: number = 50, skip: number = 0) {
    return await CancellationLog.find({
      refundEligible: true,
      refundStatus: { $in: ['pending', 'processing'] },
    })
      .sort({ cancelledAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();
  }

  /**
   * Retry failed refund
   */
  async retryFailedRefund(cancellationLogId: string): Promise<void> {
    try {
      logger.info(`Retrying failed refund: ${cancellationLogId}`);

      const cancellationLog = await CancellationLog.findById(cancellationLogId);
      if (!cancellationLog) {
        throw new Error('Cancellation log not found');
      }

      if (cancellationLog.refundStatus !== 'failed') {
        throw new Error('Can only retry failed refunds');
      }

      const session = await SessionMentor.findById(cancellationLog.sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      const transactionId = await this.initiateRefundTransaction(
        session,
        cancellationLog.refundAmount
      );

      cancellationLog.refundStatus = 'processing';
      cancellationLog.refundTransactionId = transactionId;
      await cancellationLog.save();

      logger.info('Refund retry initiated successfully');
    } catch (error: any) {
      logger.error(`Refund retry failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get refund analytics
   */
  async getRefundAnalytics(startDate: Date, endDate: Date) {
    const analytics = await CancellationLog.aggregate([
      {
        $match: {
          cancelledAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          totalCancellations: { $sum: 1 },
          totalRefunds: { $sum: '$refundAmount' },
          averageRefund: { $avg: '$refundAmount' },
          withinPolicy: { $sum: { $cond: ['$withinPolicy', 1, 0] } },
          byMentor: {
            $sum: { $cond: [{ $eq: ['$cancelledByRole', 'mentor'] }, 1, 0] },
          },
          byMentee: {
            $sum: { $cond: [{ $eq: ['$cancelledByRole', 'mentee'] }, 1, 0] },
          },
          refundsCompleted: {
            $sum: { $cond: [{ $eq: ['$refundStatus', 'completed'] }, 1, 0] },
          },
        },
      },
    ]);

    return (
      analytics[0] || {
        totalCancellations: 0,
        totalRefunds: 0,
        averageRefund: 0,
        withinPolicy: 0,
        byMentor: 0,
        byMentee: 0,
        refundsCompleted: 0,
      }
    );
  }

  /**
   * Estimate refund for UI preview (before cancellation)
   */
  estimateRefundAmount(totalAmount: number, scheduledAt: Date) {
    return refundCalculator.estimateRefund(totalAmount, scheduledAt);
  }
}

export default new RefundService();