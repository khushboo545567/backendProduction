import mongoose from 'mongoose';
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
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from '@/shared/errors/app.error';

// Razorpay instance - initialized once, reused across calls
let razorpay: Razorpay | null = null;

function getRazorpay(): Razorpay {
  if (!razorpay) {
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;

    if (!key_id || !key_secret) {
      throw new Error(
        'Razorpay not configured - set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env'
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
   * Session update ek hi atomic findByIdAndUpdate se hota hai. Pehle do alag save()
   * calls the, jisse process crash hone par session CANCELLED state mein atak sakta tha.
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
      const session = await SessionMentor.findOne(
        mongoose.Types.ObjectId.isValid(input.sessionId)
          ? { $or: [{ sessionId: input.sessionId }, { _id: input.sessionId }] }
          : { sessionId: input.sessionId }
      );
      if (!session) {
        throw new NotFoundError('Session');
      }

      const targetBooking = input.bookingId
        ? session.bookings?.find((b: any) => b._id?.toString() === input.bookingId || b.bookingId === input.bookingId)
        : undefined;

      if (input.bookingId && !targetBooking) {
        throw new NotFoundError('Booking');
      }

      const effectiveMenteeId = targetBooking?.menteeId || targetBooking?.bookedBy || session.menteeId;
      const effectivePricing = targetBooking?.pricing?.totalAmount ? targetBooking.pricing : (session.pricing || { totalAmount: 0, basePrice: 0, platformFee: 0 });
      const effectiveScheduledAt = targetBooking?.scheduledAt || session.scheduledAt;

      // Step 2: Idempotency check - prevent double refund
      if (
        session.status === BookingStatus.CANCELLED ||
        session.status === BookingStatus.REFUNDED ||
        (targetBooking && targetBooking.status === 'cancelled')
      ) {
        logger.warn(`Refund already processed for session: ${input.sessionId}`);
        throw new ConflictError('Session or booking has already been cancelled');
      }

      // session.mentorId Mentor-PROFILE id hai, mentor ka auth userId nahi.
      // Mentor khud cancel kare to input.userId se direct compare kabhi match nahi hota,
      // isliye pehle mentor ka real userId resolve karte hain.
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
      // bookings[].status schema enum mein 'refunded' nahi hai, sirf top-level status
      // aur payment.status mein hai. Booking-array status hamesha 'cancelled' rehta hai;
      // refund state payment.status aur top-level session status se track hota hai.
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
          refundCalculation.refundAmount,
          targetBooking
        );

        // Single atomic update
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

      // Check if there are other active bookings in this session
      const targetBookingId = (targetBooking as any)?._id?.toString();
      const hasOtherActiveBookings = session.bookings?.some(
        (b: any) => b._id?.toString() !== targetBookingId && b.status !== 'cancelled'
      );

      const updateFields: any = {
        ...paymentUpdate,
      };

      // If there are no other active bookings (or 1-on-1 session), update top-level status as well
      if (!hasOtherActiveBookings) {
        updateFields.status = sessionStatus;
        updateFields.isBooked = false;
      }

      if (input.bookingId && targetBooking) {
        await SessionMentor.findByIdAndUpdate(
          session._id,
          {
            $set: {
              'bookings.$[elem].status': bookingStatus,
              ...updateFields,
            },
          },
          {
            runValidators: true,
            arrayFilters: [{ 'elem._id': (targetBooking as any)._id }],
          }
        );
      } else {
        await SessionMentor.findByIdAndUpdate(
          session._id,
          {
            $set: {
              status: sessionStatus,
              isBooked: false,
              ...updateFields,
            },
          },
          { runValidators: true }
        );
      }

      // Step 8: Send notifications (non-critical - failure does not throw)
      // Cancelled booking ka availability slot wapas free karo
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
      try {
        cancellationLog.mentorNotified = true;
        cancellationLog.menteeNotified = true;
        cancellationLog.notificationsSentAt = new Date();
        await cancellationLog.save();
      } catch (logErr: any) {
        logger.warn(`Failed to update notificationsSentAt in cancellationLog: ${logErr.message}`);
      }

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
   * Missed session (mentor ne start nahi kiya / request par respond nahi kiya) ka refund.
   * Hamesha 100%, past-session check nahi lagta. Double-refund atomic claim se rukta hai.
   */
  async processMissedRefund(input: {
    sessionId: string;
    bookingId: string;
    userId: string;
  }): Promise<RefundResult> {
    try {
      logger.info(`Processing missed-session refund: ${input.sessionId} / ${input.bookingId}`);

      const session: any = await SessionMentor.findOne({ sessionId: input.sessionId });
      if (!session) throw new NotFoundError('Session');

      const booking: any = session.bookings?.find((b: any) => b._id?.toString() === input.bookingId);
      if (!booking) throw new NotFoundError('Booking');

      const menteeId = booking.menteeId || booking.bookedBy;
      if (menteeId !== input.userId) {
        throw new ForbiddenError('Only the student can request a refund for this booking');
      }
      if (booking.status !== BookingStatus.MISSED) {
        throw new ConflictError('Refund is only available for missed sessions');
      }

      const pricing = booking.pricing?.totalAmount ? booking.pricing : session.pricing;
      const refundAmount = Number(pricing?.totalAmount || 0);
      if (refundAmount <= 0) {
        throw new BadRequestError(
          'This was a free session, so there is nothing to refund. You can reschedule it instead.'
        );
      }

      // Atomic claim: jo pehle claim karega wahi refund karega (double click / 2 tabs safe)
      const claim = await SessionMentor.updateOne(
        {
          sessionId: session.sessionId,
          bookings: { $elemMatch: { _id: booking._id, status: BookingStatus.MISSED } },
        } as any,
        { $set: { 'bookings.$.status': BookingStatus.CANCELLED } }
      );
      if (claim.modifiedCount === 0) {
        throw new ConflictError('This booking was already refunded or rescheduled');
      }

      let cancellationLog: any;
      try {
        cancellationLog = await this.createCancellationLog(
          session,
          {
            sessionId: input.sessionId,
            userId: input.userId,
            reason: 'Session missed: mentor did not start the session',
            cancellationCategory: 'other',
          },
          {
            hoursBeforeSession: 0,
            withinPolicy: true,
            refundEligible: true,
            refundPercentage: 100,
            refundAmount,
          },
          'mentee'
        );
      } catch (logErr) {
        // Paisa abhi nahi gaya, isliye claim wapas missed kar do taaki student dobara try kar sake
        await SessionMentor.updateOne(
          {
            sessionId: session.sessionId,
            bookings: { $elemMatch: { _id: booking._id, status: BookingStatus.CANCELLED } },
          } as any,
          { $set: { 'bookings.$.status': BookingStatus.MISSED } }
        ).catch(() => undefined);
        throw logErr;
      }

      // Yahan se paisa move hota hai, isliye ab revert nahi karte (double refund ka risk)
      const transactionId = await this.initiateRefundTransaction(session, refundAmount, booking);
      cancellationLog.refundStatus = 'processing';
      cancellationLog.refundTransactionId = transactionId;
      await cancellationLog.save();

      try {
        const otherActive = (session.bookings || []).some(
          (b: any) =>
            b._id?.toString() !== input.bookingId &&
            ['pending', 'confirmed', 'rescheduled', 'in_progress'].includes(b.status)
        );
        const $set: any = {
          'payment.status': PaymentStatus.REFUNDED,
          'payment.refundAmount': refundAmount,
          'payment.refundedAt': new Date(),
          'payment.refundReason': 'Session missed',
        };
        if (!otherActive) {
          $set.status = BookingStatus.REFUNDED;
          $set.isBooked = false;
        }
        await SessionMentor.updateOne({ _id: session._id }, { $set });
      } catch (updErr: any) {
        logger.error(`Missed refund: session update failed after refund ${transactionId}: ${updErr.message}`);
      }

      NotificationService.sendNotification({
        userId: input.userId,
        type: NotificationType.REFUND_PROCESSED,
        channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
        data: {
          title: 'Refund initiated',
          message: `A full refund of ₹${refundAmount} for "${session.title}" has been initiated. It usually reflects in 3-5 business days.`,
          refundAmount,
          sessionId: session.sessionId,
        },
      }).catch((e) => logger.error('Notification failed (missed refund):', e));

      return {
        success: true,
        refundAmount,
        refundPercentage: 100,
        refundEligible: true,
        refundStatus: 'processing',
        transactionId,
        message: `Full refund of ₹${refundAmount} initiated.`,
        cancellationLog,
      };
    } catch (error: any) {
      logger.error(`Missed refund failed: ${error.message}`);
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
    if (menteeIdToCheck !== userId && mentorUserId !== userId) {
      throw new ForbiddenError('You are not authorized to cancel this session');
    }

    if (session.status === BookingStatus.CANCELLED || session.status === BookingStatus.REFUNDED) {
      throw new ConflictError('Session is already cancelled');
    }

    if (session.status === BookingStatus.COMPLETED) {
      throw new ConflictError('Cannot cancel a completed session');
    }

    if (session.status === BookingStatus.IN_PROGRESS) {
      throw new ConflictError('Cannot cancel a session that is in progress');
    }

    const dateToCheck = effectiveScheduledAt ?? session.scheduledAt;
    if (dateToCheck && new Date(dateToCheck) < new Date()) {
      throw new ConflictError('Cannot cancel a past session');
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
      sessionId: session.sessionId || session._id.toString(),
      cancelledBy: input.userId,
      cancelledByRole: userRole,
      sessionType: session.sessionType,
      scheduledAt: session.scheduledAt,
      timezone: session.timezone || 'UTC',
      sessionPrice: session.pricing?.totalAmount ?? 0,
      reason: input.reason,
      cancellationCategory: input.cancellationCategory || 'other',
      additionalNotes: input.additionalNotes,
      hoursBeforeSession: refundCalculation.hoursBeforeSession ?? 0,
      withinPolicy: refundCalculation.withinPolicy ?? false,
      refundEligible: refundCalculation.refundEligible ?? false,
      refundPercentage: refundCalculation.refundPercentage ?? 0,
      refundAmount: refundCalculation.refundAmount ?? 0,
      refundStatus: refundCalculation.refundEligible ? 'pending' : 'not_applicable',
      cancelledAt: new Date(),
    });

    logger.info(`Cancellation log created: ${cancellationLog._id}`);
    return cancellationLog;
  }

  /**
   * Initiate refund with Razorpay.
   * gatewayPaymentId booking-level payment se aata hai (fallback: session-level).
   *
   * Razorpay refund docs: https://razorpay.com/docs/api/refunds/
   */
  private async initiateRefundTransaction(
    session: any,
    refundAmount: number,
    booking?: any
  ): Promise<string> {
    const sessionKey = String(session.sessionId || session._id);

    // Booking pass nahi hui (retry flow) to pehli paid booking le lo
    const targetBooking =
      booking || (session.bookings || []).find((b: any) => b.payment?.gatewayPaymentId);

    const gatewayPaymentId =
      targetBooking?.payment?.gatewayPaymentId || session.payment?.gatewayPaymentId;

    if (!gatewayPaymentId) {
      logger.warn(`No gateway payment ID for session ${sessionKey}. Queuing for manual refund.`);
      const pendingId = `REFUND_MANUAL_${Date.now()}_${sessionKey}`;
      logger.warn(`Manual refund queued: ${pendingId} - amount: Rs.${refundAmount}`);
      return pendingId;
    }

    try {
      const refund = await getRazorpay().payments.refund(gatewayPaymentId, {
        amount: Math.round(refundAmount * 100), // Razorpay expects paise (integer)
        speed: 'normal',
        notes: {
          sessionId: sessionKey,
          reason: 'User cancellation via platform',
        },
      });

      logger.info(`Razorpay refund initiated: ${refund.id} for Rs.${refundAmount}`);
      return refund.id;
    } catch (error: any) {
      // Razorpay/config failure se poori cancellation 500 na ho. Manual refund queue mein
      // daal do; session cancel ho jayega aur admin baad mein refund process karega.
      logger.error(`Razorpay refund failed, falling back to manual queue: ${error.message}`);
      const pendingId = `REFUND_MANUAL_FALLBACK_${Date.now()}_${sessionKey}`;
      logger.warn(`Manual refund queued after Razorpay failure: ${pendingId} - amount: Rs.${refundAmount}`);
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

      // session.mentorId Mentor-profile id hai, auth userId nahi -
      // mentor ka real userId pehle resolve karo (processRefund jaisa hi pattern).
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

      // Pata karo asal mein cancel kisne kiya, taaki notification
      // (a) doosri party ko jaye, canceller ko wapas nahi, aur
      // (b) cancel karne wale ka naam sahi dikhe.
      const cancelledByMentee = cancelledByUserId === mentee.userId;
      const cancellerName = cancelledByMentee
        ? (mentee.fullName || mentee.email)
        : (mentor.fullName || mentor.email);

      if (cancelledByMentee) {
        // Mentee cancelled -> notify the mentor only
        NotificationService.sendNotification({
          userId: mentor.userId,
          type: NotificationType.SESSION_CANCELLED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: 'Session Cancelled',
            message: `${cancellerName} cancelled the "${session.sessionType}" session. Reason: ${reason}`,
          },
        }).catch((e) => logger.error('In-app notification failed (refund -> mentor):', e));
      } else {
        // Mentor cancelled -> notify the mentee only
        NotificationService.sendNotification({
          userId: mentee.userId,
          type: NotificationType.SESSION_CANCELLED,
          channels: [NotificationChannel.IN_APP],
          data: {
            title: refundCalculation.refundEligible ? 'Session Cancelled - Refund Processing' : 'Session Cancelled',
            message: refundCalculation.refundEligible
              ? `${cancellerName} cancelled your "${session.sessionType}" session. Reason: ${reason}. A refund of ₹${refundCalculation.refundAmount} is being processed.`
              : `${cancellerName} cancelled your "${session.sessionType}" session. Reason: ${reason}`,
          },
        }).catch((e) => logger.error('In-app notification failed (refund -> mentee):', e));
      }

      logger.info('Refund notifications sent successfully');
    } catch (error: any) {
      // Non-critical - log but do not throw
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

      const session = await SessionMentor.findOne({ sessionId: cancellationLog.sessionId });
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

      const session = await SessionMentor.findOne({ sessionId: cancellationLog.sessionId });
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

      const session = await SessionMentor.findOne({ sessionId: cancellationLog.sessionId });
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