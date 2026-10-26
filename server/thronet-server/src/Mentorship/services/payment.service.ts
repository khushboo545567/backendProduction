// server/thronet-server/src/Mentorship/services/payment.service.ts
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import MentorshipPayment, {
  FulfillmentStatus,
  GatewayPaymentStatus,
  IPayment,
  PaymentPurpose,
} from '../models/Payment';
import Package, { PackageType } from '../models/Package';
import { SessionMentor, CancellationLog } from '../models';
import { logger } from '@/shared/logger.util';
import { BadRequestError, NotFoundError } from '@/shared/errors/app.error';
import { BookingStatus } from '@/shared/constants/bookingStatus';
import {
  computePricingFromBase,
  PACKAGE_BASE_PRICE,
  toPaise,
  ServerPricing,
} from '../utils/pricing.util';
import mentorshipSessionService from './mentorshipSession.service';
import packageService from './package.service';
import refundService from './refund.service';

const FULFILLMENT_LOCK_MS = 2 * 60 * 1000;

let razorpayClient: Razorpay | null = null;

function getRazorpay(): Razorpay {
  if (!razorpayClient) {
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key_id || !key_secret) {
      throw new Error('Razorpay not configured - set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    }
    razorpayClient = new Razorpay({ key_id, key_secret });
  }
  return razorpayClient;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function compact<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {};
  Object.keys(obj).forEach((k) => {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out as Partial<T>;
}

export interface SessionOrderInput {
  sessionId: string;
  mentorId: string;
  availabilityId: string;
  slotTime: string;
  scheduledAt: string;
  timezone: string;
}

export interface PackageOrderInput {
  packageType: string;
  mentorId?: string;
}

export interface VerifyInput {
  paymentId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

export interface PaymentOrderResponse {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  pricing: ServerPricing;
  description: string;
}

export interface FulfillmentResult {
  paymentId: string;
  purpose: PaymentPurpose;
  status: 'fulfilled' | 'processing';
  sessionId?: string;
  bookingId?: string;
  packageId?: string;
}

type FulfillmentRefs = { sessionId?: string; bookingId?: string; packageId?: string };

class PaymentService {
  // ------------------------------------------------------------------
  // Order creation
  // ------------------------------------------------------------------

  async createSessionOrder(userId: string, input: SessionOrderInput): Promise<PaymentOrderResponse> {
    const sessionQuery: any = Types.ObjectId.isValid(input.sessionId)
      ? { $or: [{ sessionId: input.sessionId }, { _id: new Types.ObjectId(input.sessionId) }] }
      : { sessionId: input.sessionId };

    const session: any = await SessionMentor.findOne(sessionQuery).lean();
    if (!session) throw new NotFoundError('Session not found');

    if (
      [BookingStatus.CANCELLED, BookingStatus.NO_SHOW, BookingStatus.REFUNDED].includes(session.status)
    ) {
      throw new BadRequestError('Session is not available for booking');
    }
    if (session.mentorId !== input.mentorId) {
      throw new BadRequestError('Session does not belong to this mentor');
    }

    const scheduledAt = new Date(input.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestError('Selected slot is in the past');
    }

    // Price hamesha server se. Agar tumhare UI ka Service.price pricing.basePrice se
    // alag field hai to sirf yahi ek line badalni hai.
    const pricing = computePricingFromBase(session.pricing?.basePrice);
    if (pricing.totalAmount <= 0) {
      throw new BadRequestError('This session is free, no payment required');
    }

    return this.createOrder({
      userId,
      purpose: PaymentPurpose.SESSION_BOOKING,
      pricing,
      description: session.title || 'Mentorship session',
      context: {
        sessionId: session.sessionId,
        mentorId: input.mentorId,
        availabilityId: input.availabilityId,
        slotTime: input.slotTime,
        scheduledAt: scheduledAt.toISOString(),
        timezone: input.timezone,
        title: session.title,
      },
    });
  }

  async createPackageOrder(userId: string, input: PackageOrderInput): Promise<PaymentOrderResponse> {
    const allowed = Object.values(PackageType).filter((t) => t !== PackageType.CUSTOM) as string[];
    if (!allowed.includes(input.packageType)) {
      throw new BadRequestError('Invalid package type');
    }

    const priced = packageService.getPackagePricing(input.packageType as any, PACKAGE_BASE_PRICE);
    const total = Math.round(priced.totalPrice);
    if (total <= 0) throw new BadRequestError('Invalid package price');

    return this.createOrder({
      userId,
      purpose: PaymentPurpose.PACKAGE,
      pricing: {
        basePrice: Math.round(priced.actualPrice),
        platformFee: 0,
        gst: 0,
        totalAmount: total,
        currency: 'INR',
      },
      description: priced.name,
      context: { packageType: input.packageType, mentorId: input.mentorId },
    });
  }

  private async createOrder(args: {
    userId: string;
    purpose: PaymentPurpose;
    pricing: ServerPricing;
    context: Record<string, any>;
    description: string;
  }): Promise<PaymentOrderResponse> {
    const paymentId = uuidv4();
    const amountPaise = toPaise(args.pricing.totalAmount);

    let order: any;
    try {
      order = await getRazorpay().orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: `mp_${paymentId.replace(/-/g, '').slice(0, 30)}`,
        notes: { paymentId, userId: args.userId, purpose: args.purpose },
      });
    } catch (error: any) {
      logger.error(`Razorpay order creation failed: ${error?.error?.description || error?.message}`);
      throw new BadRequestError('Unable to start payment right now. Please try again.');
    }

    await MentorshipPayment.create({
      paymentId,
      userId: args.userId,
      purpose: args.purpose,
      razorpayOrderId: order.id,
      amount: args.pricing.totalAmount,
      amountPaise,
      currency: 'INR',
      pricing: {
        basePrice: args.pricing.basePrice,
        platformFee: args.pricing.platformFee,
        gst: args.pricing.gst,
        totalAmount: args.pricing.totalAmount,
      },
      status: GatewayPaymentStatus.CREATED,
      context: args.context,
      fulfillment: { status: FulfillmentStatus.PENDING, attempts: 0 },
    });

    return {
      paymentId,
      orderId: order.id,
      amount: amountPaise,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID as string,
      pricing: args.pricing,
      description: args.description,
    };
  }

  // ------------------------------------------------------------------
  // Verify (called by the browser after Razorpay Checkout succeeds)
  // ------------------------------------------------------------------

  async verifyAndFulfill(userId: string, input: VerifyInput): Promise<FulfillmentResult> {
    const payment = await MentorshipPayment.findOne({ paymentId: input.paymentId, userId });
    if (!payment) throw new NotFoundError('Payment not found');

    if (payment.razorpayOrderId !== input.razorpayOrderId) {
      throw new BadRequestError('Payment verification failed');
    }

    if (
      !this.isValidCheckoutSignature(
        input.razorpayOrderId,
        input.razorpayPaymentId,
        input.razorpaySignature
      )
    ) {
      logger.warn(`Invalid checkout signature for payment ${payment.paymentId}`);
      throw new BadRequestError('Payment verification failed');
    }

    const method = await this.confirmWithGateway(payment, input.razorpayPaymentId);
    await this.markPaid(payment.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature, method);

    await this.fulfill(payment.paymentId);

    const settled = await this.waitForSettled(payment.paymentId);
    return this.toResult(settled);
  }

  async getPaymentStatus(userId: string, paymentId: string) {
    const payment = await MentorshipPayment.findOne({ paymentId, userId }).lean();
    if (!payment) throw new NotFoundError('Payment not found');
    return {
      paymentId: payment.paymentId,
      purpose: payment.purpose,
      paymentStatus: payment.status,
      fulfillmentStatus: payment.fulfillment?.status,
      sessionId: payment.fulfillment?.sessionId,
      bookingId: payment.fulfillment?.bookingId,
      packageId: payment.fulfillment?.packageId,
      error: payment.fulfillment?.error,
    };
  }

  private isValidCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) throw new Error('RAZORPAY_KEY_SECRET is not set');
    const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    return safeEqual(expected, signature);
  }

  /**
   * Gateway se payment fetch karke order/amount match karta hai, aur agar
   * payment sirf "authorized" hai to capture karta hai.
   */
  private async confirmWithGateway(
    payment: IPayment,
    razorpayPaymentId: string
  ): Promise<string | undefined> {
    try {
      const rp: any = await getRazorpay().payments.fetch(razorpayPaymentId);

      if (rp.order_id !== payment.razorpayOrderId || Number(rp.amount) !== payment.amountPaise) {
        logger.error(
          `Gateway mismatch for payment ${payment.paymentId}: order ${rp.order_id}, amount ${rp.amount}`
        );
        throw new BadRequestError('Payment verification failed');
      }

      if (rp.status === 'authorized') {
        await getRazorpay().payments.capture(razorpayPaymentId, payment.amountPaise, payment.currency);
      } else if (rp.status !== 'captured') {
        throw new BadRequestError('Payment is not completed yet');
      }
      return rp.method;
    } catch (error: any) {
      if (error instanceof BadRequestError) throw error;
      // Signature already verify ho chuki hai; gateway fetch fail hua to webhook settle kar dega.
      logger.warn(`Gateway confirmation skipped for ${payment.paymentId}: ${error?.message}`);
      return undefined;
    }
  }

  private async markPaid(
    orderId: string,
    razorpayPaymentId: string,
    signature?: string,
    method?: string
  ): Promise<IPayment | null> {
    const updated = await MentorshipPayment.findOneAndUpdate(
      {
        razorpayOrderId: orderId,
        status: { $in: [GatewayPaymentStatus.CREATED, GatewayPaymentStatus.FAILED] },
      },
      {
        $set: compact({
          status: GatewayPaymentStatus.PAID,
          razorpayPaymentId,
          razorpaySignature: signature,
          method,
          paidAt: new Date(),
        }),
        $unset: { failureReason: 1 },
      },
      { new: true }
    );
    if (updated) return updated;
    return MentorshipPayment.findOne({ razorpayOrderId: orderId });
  }

  // ------------------------------------------------------------------
  // Fulfillment (booking / package) - idempotent, safe for verify + webhook race
  // ------------------------------------------------------------------

  private async fulfill(paymentId: string): Promise<void> {
    const claimed = await MentorshipPayment.findOneAndUpdate(
      {
        paymentId,
        status: GatewayPaymentStatus.PAID,
        $or: [
          { 'fulfillment.status': FulfillmentStatus.PENDING },
          {
            'fulfillment.status': FulfillmentStatus.PROCESSING,
            'fulfillment.startedAt': { $lt: new Date(Date.now() - FULFILLMENT_LOCK_MS) },
          },
        ],
      },
      {
        $set: { 'fulfillment.status': FulfillmentStatus.PROCESSING, 'fulfillment.startedAt': new Date() },
        $inc: { 'fulfillment.attempts': 1 },
      },
      { new: true }
    );

    // Koi aur already fulfill kar chuka ya kar raha hai
    if (!claimed) return;

    try {
      const refs =
        claimed.purpose === PaymentPurpose.SESSION_BOOKING
          ? await this.fulfillSession(claimed)
          : await this.fulfillPackage(claimed);
      await this.markFulfilled(claimed.paymentId, refs);
    } catch (error: any) {
      // Booking ban chuki thi lekin process beech mein fail hua? To duplicate refund mat karo.
      const existing = await this.findExistingFulfillment(claimed);
      if (existing) {
        await this.markFulfilled(claimed.paymentId, existing);
        return;
      }

      const baseMessage = error?.message || 'Booking could not be completed.';
      logger.error(`Fulfillment failed for payment ${claimed.paymentId}: ${baseMessage}`);

      const refunded = await this.refundFully(claimed, `Auto refund: ${baseMessage}`.slice(0, 200));
      const finalMessage = refunded
        ? `${baseMessage} Your payment will be refunded automatically within 5-7 working days.`
        : `${baseMessage} We have received your payment and our team will resolve this shortly.`;

      await MentorshipPayment.updateOne(
        { paymentId: claimed.paymentId },
        {
          $set: {
            'fulfillment.status': refunded ? FulfillmentStatus.REFUNDED : FulfillmentStatus.FAILED,
            'fulfillment.error': finalMessage,
            'fulfillment.completedAt': new Date(),
          },
        }
      );

      throw new BadRequestError(finalMessage);
    }
  }

  private async fulfillSession(payment: IPayment): Promise<FulfillmentRefs> {
    const ctx = payment.context || {};
    const result = await mentorshipSessionService.bookSession(
      {
        sessionId: ctx.sessionId,
        mentorId: ctx.mentorId,
        menteeId: payment.userId,
        availabilityId: ctx.availabilityId,
        slotTime: ctx.slotTime,
        scheduledAt: ctx.scheduledAt,
        timezone: ctx.timezone,
        paymentMethod: 'razorpay',
      },
      undefined,
      { payment }
    );

    return {
      sessionId: result?.sessionId,
      bookingId: result?.booking?._id ? String(result.booking._id) : undefined,
    };
  }

  private async fulfillPackage(payment: IPayment): Promise<FulfillmentRefs> {
    const ctx = payment.context || {};
    const pkg: any = await packageService.createPackage({
      packageType: ctx.packageType as PackageType,
      userId: payment.userId,
      mentorId: ctx.mentorId,
      paymentMethod: 'razorpay',
      transactionId: payment.razorpayPaymentId,
    });
    return { packageId: pkg?.packageId };
  }

  private async findExistingFulfillment(payment: IPayment): Promise<FulfillmentRefs | null> {
    if (!payment.razorpayPaymentId) return null;

    if (payment.purpose === PaymentPurpose.SESSION_BOOKING) {
      const session: any = await SessionMentor.findOne({
        sessionId: payment.context?.sessionId,
        'bookings.payment.gatewayPaymentId': payment.razorpayPaymentId,
      }).lean();
      if (!session) return null;
      const booking = (session.bookings || []).find(
        (b: any) => b.payment?.gatewayPaymentId === payment.razorpayPaymentId
      );
      return {
        sessionId: session.sessionId,
        bookingId: booking?._id ? String(booking._id) : undefined,
      };
    }

    const pkg: any = await Package.findOne({ 'payment.transactionId': payment.razorpayPaymentId }).lean();
    return pkg ? { packageId: pkg.packageId } : null;
  }

  private async markFulfilled(paymentId: string, refs: FulfillmentRefs): Promise<void> {
    await MentorshipPayment.updateOne(
      { paymentId },
      {
        $set: compact({
          'fulfillment.status': FulfillmentStatus.FULFILLED,
          'fulfillment.completedAt': new Date(),
          'fulfillment.sessionId': refs.sessionId,
          'fulfillment.bookingId': refs.bookingId,
          'fulfillment.packageId': refs.packageId,
        }),
        $unset: { 'fulfillment.error': 1 },
      }
    );
  }

  private async refundFully(payment: IPayment, reason: string): Promise<boolean> {
    if (!payment.razorpayPaymentId) return false;
    try {
      const refund: any = await getRazorpay().payments.refund(payment.razorpayPaymentId, {
        amount: payment.amountPaise,
        speed: 'normal',
        notes: { paymentId: payment.paymentId, reason },
      });
      await MentorshipPayment.updateOne(
        { paymentId: payment.paymentId },
        {
          $push: {
            refunds: {
              refundId: refund.id,
              amount: payment.amount,
              status: 'processing',
              reason,
              createdAt: new Date(),
            },
          },
        }
      );
      logger.info(`Auto refund initiated ${refund.id} for payment ${payment.paymentId}`);
      return true;
    } catch (error: any) {
      logger.error(
        `Auto refund FAILED for payment ${payment.paymentId} - manual action needed: ${
          error?.error?.description || error?.message
        }`
      );
      return false;
    }
  }

  private async waitForSettled(paymentId: string, timeoutMs = 8000): Promise<IPayment> {
    const startedAt = Date.now();
    for (;;) {
      const doc = await MentorshipPayment.findOne({ paymentId });
      if (!doc) throw new NotFoundError('Payment not found');
      const s = doc.fulfillment.status;
      if (s !== FulfillmentStatus.PENDING && s !== FulfillmentStatus.PROCESSING) return doc;
      if (Date.now() - startedAt >= timeoutMs) return doc;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private toResult(doc: IPayment): FulfillmentResult {
    const f = doc.fulfillment;
    if (f.status === FulfillmentStatus.FULFILLED) {
      return {
        paymentId: doc.paymentId,
        purpose: doc.purpose,
        status: 'fulfilled',
        sessionId: f.sessionId,
        bookingId: f.bookingId,
        packageId: f.packageId,
      };
    }
    if (f.status === FulfillmentStatus.REFUNDED || f.status === FulfillmentStatus.FAILED) {
      throw new BadRequestError(f.error || 'Booking could not be completed. Please contact support.');
    }
    return { paymentId: doc.paymentId, purpose: doc.purpose, status: 'processing' };
  }

  // ------------------------------------------------------------------
  // Webhook
  // ------------------------------------------------------------------

  async handleWebhook(rawBody: Buffer | string | undefined, signature: string | undefined): Promise<void> {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set');
    if (!rawBody || !signature) throw new BadRequestError('Invalid webhook request');

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEqual(expected, signature)) {
      logger.warn('Razorpay webhook signature mismatch');
      throw new BadRequestError('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString());
    const type: string = event?.event;

    switch (type) {
      case 'payment.captured':
      case 'order.paid':
        await this.onPaymentCaptured(event);
        break;
      case 'payment.failed':
        await this.onPaymentFailed(event);
        break;
      case 'refund.processed':
        await this.onRefundEvent(event, 'processed');
        break;
      case 'refund.failed':
        await this.onRefundEvent(event, 'failed');
        break;
      default:
        logger.info(`Razorpay webhook ignored: ${type}`);
    }
  }

  private async onPaymentCaptured(event: any): Promise<void> {
    const entity = event?.payload?.payment?.entity;
    const orderId: string | undefined = entity?.order_id || event?.payload?.order?.entity?.id;
    if (!entity?.id || !orderId) return;

    const existing = await MentorshipPayment.findOne({ razorpayOrderId: orderId });
    // Order humare system ka nahi (same Razorpay account par doosre products) to ignore
    if (!existing) return;

    if (Number(entity.amount) !== existing.amountPaise) {
      logger.error(`Webhook amount mismatch for order ${orderId}: ${entity.amount}`);
      return;
    }

    const payment = await this.markPaid(orderId, entity.id, undefined, entity.method);
    if (payment && payment.status === GatewayPaymentStatus.PAID) {
      try {
        await this.fulfill(payment.paymentId);
      } catch (error: any) {
        logger.error(`Webhook fulfillment failed for ${payment.paymentId}: ${error?.message}`);
      }
    }
  }

  private async onPaymentFailed(event: any): Promise<void> {
    const entity = event?.payload?.payment?.entity;
    if (!entity?.order_id) return;
    await MentorshipPayment.updateOne(
      { razorpayOrderId: entity.order_id, status: GatewayPaymentStatus.CREATED },
      {
        $set: {
          status: GatewayPaymentStatus.FAILED,
          failureReason: entity.error_description || entity.error_reason || 'Payment failed',
        },
      }
    );
  }

  private async onRefundEvent(event: any, outcome: 'processed' | 'failed'): Promise<void> {
    const refund = event?.payload?.refund?.entity;
    if (!refund?.id) return;

    const payment = await MentorshipPayment.findOne({ razorpayPaymentId: refund.payment_id });
    if (payment) {
      const entry = payment.refunds.find((r) => r.refundId === refund.id);
      if (entry) {
        entry.status = outcome;
      } else {
        payment.refunds.push({
          refundId: refund.id,
          amount: Number(refund.amount) / 100,
          status: outcome,
          createdAt: new Date(),
        });
      }
      const refundedTotal = payment.refunds
        .filter((r) => r.status === 'processed')
        .reduce((sum, r) => sum + r.amount, 0);
      if (refundedTotal >= payment.amount) payment.status = GatewayPaymentStatus.REFUNDED;
      else if (refundedTotal > 0) payment.status = GatewayPaymentStatus.PARTIALLY_REFUNDED;
      await payment.save();
    }

    // Cancellation flow ke refunds (refund.service) ka status bhi sync karo
    try {
      const log: any = await CancellationLog.findOne({ refundTransactionId: refund.id });
      if (log) {
        if (outcome === 'processed' && log.refundStatus !== 'completed') {
          await refundService.completeRefund(String(log._id), refund.id);
        } else if (outcome === 'failed' && log.refundStatus !== 'failed') {
          await refundService.handleFailedRefund(String(log._id));
        }
      }
    } catch (error: any) {
      logger.error(`Refund webhook sync failed for ${refund.id}: ${error?.message}`);
    }
  }
}

export default new PaymentService();