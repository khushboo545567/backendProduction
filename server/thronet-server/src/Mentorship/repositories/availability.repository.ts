// repositories/availability.repository.ts
import { Availability } from '../models';
import { logger } from '@/shared/logger.util';

class AvailabilityRepository {

    /**
 * Create availability
 */
    async create(data: any): Promise<any> {
        const availability = new Availability(data);
        await availability.save();
        return availability.toObject(); // ✅ Returns plain object
    }
    /**
     * Find by availabilityId (UUID) - External identifier
     */
    async findByAvailabilityId(availabilityId: string): Promise<any | null> {
        return await Availability.findOne({ availabilityId, isDeleted: false }).lean();
    }

    /**
     * Find by ObjectId - Internal operations only
     */
    async findById(objectId: string): Promise<any | null> {
        return await Availability.findById(objectId).lean();
    }

    /**
     * Find by mentorId (UUID)
     */
    async findByMentorId(mentorId: string, query: any = {}): Promise<any[]> {
        return await Availability.find({
            mentorId,
            isDeleted: false,
            ...query
        })
            .sort({ date: 1 })
            .lean();
    }

    /**
     * Find by mentor and date
     */
    async findByMentorAndDate(mentorId: string, startDate: Date, endDate: Date): Promise<any | null> {
        return await Availability.findOne({
            mentorId,
            date: { $gte: startDate, $lte: endDate },
            isDeleted: false
        }).lean();
    }

    /**
     * Update by availabilityId (UUID)
     */
    async updateByAvailabilityId(availabilityId: string, updates: any): Promise<any | null> {
        const availability = await Availability.findOne({
            availabilityId,
            isDeleted: false
        });

        if (!availability) return null;

        Object.assign(availability, updates);
        await availability.save();
        return availability.toObject();
    }

    /**
     * Soft delete by availabilityId (UUID)
     */
    async softDeleteByAvailabilityId(availabilityId: string): Promise<boolean> {
        const availability = await Availability.findOne({
            availabilityId,
            isDeleted: false
        });

        if (!availability) return false;

        availability.isDeleted = true;
        availability.deletedAt = new Date();
        await availability.save();
        return true;
    }

    /**
 * Find all availability (no user filter)
 */
    async findAll(query: any = {}, skip: number = 0, limit: number = 10): Promise<any[]> {
        return await Availability.find({ isDeleted: false, ...query })
            .sort({ date: 1 })
            .skip(skip)
            .limit(limit)
            .lean();
    }

    /**
     * Count all availability
     */
    async count(query: any = {}): Promise<number> {
        return await Availability.countDocuments({ isDeleted: false, ...query });
    }

        /**
     * Block/unblock ALL non-booked slots of a given availability record
     * (used for "block whole date" feature — booked slots kabhi touch nahi hote)
     */
        async setAllSlotsBlocked(availabilityId: string, isBlocked: boolean, reason?: string): Promise<any | null> {
            const availability = await Availability.findOne({ availabilityId, isDeleted: false });
            if (!availability) return null;

            (availability as any).isDateBlocked = isBlocked;
            (availability as any).dateBlockReason = isBlocked ? reason : undefined;

            availability.slots.forEach((slot: any) => {
                if (!slot.isBooked) {
                    slot.isBlocked = isBlocked;
                    slot.blockReason = isBlocked ? reason : undefined;
                }
            });
    
            await availability.save();
            return availability.toObject();
        }

        /**
         * Block a whole date — creates a record if none exists yet (leave/holiday case)
         */
        async blockByDate(mentorId: string, date: Date, timezone: string, reason?: string): Promise<any> {
            const startOfDay = new Date(date); startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(date); endOfDay.setHours(23, 59, 59, 999);

            let availability = await Availability.findOne({
                mentorId,
                date: { $gte: startOfDay, $lte: endOfDay },
                isDeleted: false,
            });

            if (!availability) {
                availability = new Availability({
                    mentorId,
                    date,
                    slots: [],
                    dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase(),
                    timezone,
                    isDateBlocked: true,
                    dateBlockReason: reason,
                });
            } else {
                (availability as any).isDateBlocked = true;
                (availability as any).dateBlockReason = reason;
                availability.slots.forEach((slot: any) => {
                    if (!slot.isBooked) {
                        slot.isBlocked = true;
                        slot.blockReason = reason;
                    }
                });
            }

            await availability.save();
            return availability.toObject();
        }

        /**
         * Unblock a whole date by mentorId + date (no availabilityId needed)
         */
        async unblockByDate(mentorId: string, date: Date): Promise<any | null> {
            const startOfDay = new Date(date); startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(date); endOfDay.setHours(23, 59, 59, 999);

            const availability = await Availability.findOne({
                mentorId,
                date: { $gte: startOfDay, $lte: endOfDay },
                isDeleted: false,
            });
            if (!availability) return null;

            (availability as any).isDateBlocked = false;
            (availability as any).dateBlockReason = undefined;
            availability.slots.forEach((slot: any) => {
                if (!slot.isBooked) {
                    slot.isBlocked = false;
                    slot.blockReason = undefined;
                }
            });

            await availability.save();
            return availability.toObject();
        }
        /**
         * Get availability stats
         */
        async getStatsByMentorId(mentorId: string): Promise<any | null> {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const stats = await Availability.aggregate([
            {
                $match: {
                    mentorId,
                    date: { $gte: today },
                    isDeleted: false
                }
            },
            {
                $unwind: '$slots'
            },
            {
                $group: {
                    _id: null,
                    totalSlots: { $sum: 1 },
                    bookedSlots: {
                        $sum: { $cond: ['$slots.isBooked', 1, 0] }
                    },
                    blockedSlots: {
                        $sum: { $cond: ['$slots.isBlocked', 1, 0] }
                    },
                    availableSlots: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$slots.isBooked', false] },
                                        { $eq: ['$slots.isBlocked', false] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    }
                }
            }
        ]);

        return stats[0] || {
            totalSlots: 0,
            bookedSlots: 0,
            blockedSlots: 0,
            availableSlots: 0
        };
    }
}

export default new AvailabilityRepository();