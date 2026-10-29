import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { SessionMentor, Mentor } from '../models';
import { User } from '@/auth/models';
import { logger } from '@/shared/logger.util';

const fullName = (u: any) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

/**
 * @route GET /api/v1/mentorship/admin/refunds?status=pending|refunded&page=&limit=
 * Source of truth: bookings[].refundRequest.status (booking.status 'cancelled' ho chuka hota hai)
 */
const list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = req.query.status === 'refunded' ? 'refunded' : 'pending';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const sortField =
      status === 'refunded'
        ? 'bookings.refundRequest.refundedAt'
        : 'bookings.refundRequest.requestedAt';

    const agg: any[] = await (SessionMentor as any).aggregate([
      { $match: { 'bookings.refundRequest.status': status } },
      { $unwind: '$bookings' },
      { $match: { 'bookings.refundRequest.status': status } },
      { $sort: { [sortField]: -1 } },
      {
        $facet: {
          rows: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                sessionId: 1,
                title: 1,
                mentorId: 1,
                scheduledAt: 1,
                'bookings._id': 1,
                'bookings.menteeId': 1,
                'bookings.bookedBy': 1,
                'bookings.scheduledAt': 1,
                'bookings.pricing': 1,
                'bookings.refundRequest': 1,
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);

    const rawRows: any[] = agg[0]?.rows || [];
    const total: number = agg[0]?.total?.[0]?.count || 0;

    // Mentee + mentor names
    const menteeIds = [
      ...new Set(rawRows.map((r) => r.bookings?.menteeId || r.bookings?.bookedBy).filter(Boolean)),
    ];
    const mentorIds = [...new Set(rawRows.map((r) => r.mentorId).filter(Boolean))];

    const mentors: any[] = mentorIds.length
      ? await (Mentor as any).find({ mentorId: { $in: mentorIds } }).lean()
      : [];
    const mentorUserIds = mentors.map((m) => m.userId).filter(Boolean);

    const users: any[] =
      menteeIds.length || mentorUserIds.length
        ? await (User as any)
            .find(
              { userId: { $in: [...menteeIds, ...mentorUserIds] } },
              { userId: 1, firstName: 1, lastName: 1, _id: 0 }
            )
            .lean()
        : [];

    const userMap = new Map(users.map((u) => [u.userId, u]));
    const mentorNameMap = new Map(
      mentors.map((m) => [m.mentorId, fullName(userMap.get(m.userId)) || 'Mentor'])
    );

    const rows = rawRows.map((r) => {
      const b = r.bookings || {};
      const rr = b.refundRequest || {};
      const menteeId = b.menteeId || b.bookedBy;
      return {
        bookingId: String(b._id),
        sessionId: r.sessionId,
        title: r.title,
        scheduledAt: b.scheduledAt || r.scheduledAt,
        mentorName: mentorNameMap.get(r.mentorId) || 'Mentor',
        menteeName: fullName(userMap.get(menteeId)) || '',
        amount: Number(rr.amount ?? b.pricing?.totalAmount ?? 0),
        status: rr.status,
        refundMode: rr.refundMode,
        requestedAt: rr.requestedAt,
        refundedAt: rr.refundedAt,
        reference: rr.reference,
        details: {
          email: rr.email || undefined,
          phone: rr.phone || undefined,
          upiId: rr.upiId || undefined,
          note: rr.note || undefined,
        },
      };
    });

    res.status(200).json({
      success: true,
      message: 'Refunds retrieved successfully',
      data: rows,
      meta: { total, page, limit },
      pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error: any) {
    logger.error('Failed to list refunds:', error);
    next(error);
  }
};

/**
 * @route POST /api/v1/mentorship/admin/refunds/:bookingId/mark-refunded
 */
const markRefunded = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bookingId } = req.params;
    const reference = String(req.body?.reference || '').trim();
    const adminId = (req.user as any)?.userId || (req.user as any)?.id || '';

    const result = await (SessionMentor as any).updateOne(
      {
        bookings: {
          $elemMatch: {
            _id: new mongoose.Types.ObjectId(bookingId),
            'refundRequest.status': 'pending',
          },
        },
      },
      {
        $set: {
          'bookings.$.refundRequest.status': 'refunded',
          'bookings.$.refundRequest.refundMode': 'manual',
          'bookings.$.refundRequest.reference': reference,
          'bookings.$.refundRequest.refundedAt': new Date(),
          'bookings.$.refundRequest.handledBy': adminId,
        },
      }
    );

    if (result.modifiedCount === 0) {
      res.status(409).json({
        success: false,
        message: 'Refund not found or already marked as refunded',
      });
      return;
    }

    res.status(200).json({ success: true, message: 'Refund marked as refunded', data: null });
  } catch (error: any) {
    logger.error('Failed to mark refund as refunded:', error);
    next(error);
  }
};

export default { list, markRefunded };