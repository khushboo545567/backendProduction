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
     * Hard delete by availabilityId (UUID)
     * ✅ FIX: pehle ye sirf isDeleted=true flag set karta tha (soft delete),
     * document DB mein hamesha ke liye pada rehta tha. {mentorId, date}
     * wala unique index isDeleted ko dekhta hi nahi, isliye delete karne
     * ke baad us date ke liye dobara kabhi bhi naya availability create
     * nahi ho pata tha — E11000 duplicate-key error aata tha jo service
     * mein silently "You already have availability set for this date"
     * bankar dikhta tha, jabki table mein wo date khaali dikhti thi.
     * Ab delete document ko sach me collection se hata deta hai, isliye
     * date turant reusable ho jaati hai.
     */
    async softDeleteByAvailabilityId(availabilityId: string): Promise<boolean> {
        const result = await Availability.deleteOne({
            availabilityId,
            isDeleted: false
        });
        return result.deletedCount > 0;
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
    
                const findExisting = () =>
                    Availability.findOne({
                        mentorId,
                        date: { $gte: startOfDay, $lte: endOfDay },
                        isDeleted: false,
                    });
    
                let availability = await findExisting();
    
                if (!availability) {
                    // ✅ FIX: pehle yahan seedha `new Availability(...).save()`
                    // call hota tha — agar us date ka record already DB me
                    // hota (jaisa "Save Month" se pehle se bana hota hai) aur
                    // upar ka findOne kisi wajah se (double-click race, ya
                    // replica lag) usko miss kar deta, to save() ka insert
                    // `mentorId_1_date_1` unique index se takra ke raw MongoDB
                    // E11000 error throw karta tha — jo controller me
                    // "Failed to block date" bankar frontend tak leak ho jaata
                    // tha. Ab insert ko try/catch me wrap kiya hai: agar
                    // E11000 aaye, to record dobara fetch karke usi ko update
                    // kar dete hain, insert ki jagah — exact wahi pattern jo
                    // availabilityService.createAvailability() me already hai.
                    try {
                        const newAvailability = new Availability({
                            mentorId,
                            date,
                            slots: [],
                            dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase(),
                            timezone,
                            isDateBlocked: true,
                            dateBlockReason: reason,
                        });
                        await newAvailability.save();
                        return newAvailability.toObject();
                    } catch (err: any) {
                        if (err?.code !== 11000) throw err;
    
                        availability = await findExisting();
                        if (!availability) throw err;
                    }
                }
    
                (availability as any).isDateBlocked = true;
                (availability as any).dateBlockReason = reason;
                availability.slots.forEach((slot: any) => {
                    if (!slot.isBooked) {
                        slot.isBlocked = true;
                        slot.blockReason = reason;
                    }
                });
    
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