import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import Event from '../models/event.model';
import ResponseUtil from '@/shared/response.util';

export const resolveEventUUID = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const id = req.params.id;

    if (!id) return next();

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isObjectId = mongoose.Types.ObjectId.isValid(id) && id.length === 24;
    const isUUID = uuidRegex.test(id);

    if (!isUUID && !isObjectId) {
        return ResponseUtil.badRequest(res, 'Invalid event ID format. UUID v4 or ObjectId required.');
    }

    let event: any = null;
    if (isObjectId) {
        event = await Event.findById(id).select('_id eventId company title').lean();
    }
    if (!event && isUUID) {
        event = await Event.findOne({ eventId: id }).select('_id eventId company title').lean();
    }

    if (!event) {
        return ResponseUtil.notFound(res, 'Event not found');
    }

    (req as any).resolvedObjectId = event._id.toString();
    (req as any).resolvedEvent = event;
    next();
};