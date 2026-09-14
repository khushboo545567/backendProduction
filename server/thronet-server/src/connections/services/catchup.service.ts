// src/connections/services/catchup.service.ts
import { Connection, User, Contact } from '@/shared/models/index.models';
import Experience from '@/Profile/models/Experience.model';
import { LoggerUtil } from '@/shared/logger.util';

export interface CatchUpItem {
    type: 'job_change' | 'work_anniversary' | 'birthday';
    userId: string;
    firstName: string;
    lastName?: string;
    profilePhotoId?: string | null;
    companyName?: string;
    position?: string;
    years?: number;
    eventDate: string; // ISO date string
}

// Job change dikhega agar naya role pichle N din ke andar shuru hua ho
const JOB_CHANGE_WINDOW_DAYS = 30;

function isSameMonthDay(a: Date, b: Date): boolean {
    return a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function diffYears(from: Date, to: Date): number {
    return to.getFullYear() - from.getFullYear();
}

class CatchUpService {
    /**
     * ✅ User ke active connections ke Experience + DOB data se
     * job changes, work anniversaries, aur birthdays compute karta hai.
     * Sab kuch real data se — koi mock/fake entry nahi.
     */
    static async getCatchUpFeed(userId: string): Promise<CatchUpItem[]> {
        try {
            const today = new Date();

            // 1. User ke saare active connections nikalo
            const connections = await Connection.find({
                $or: [{ fromUserId: userId }, { toUserId: userId }],
                status: 'active',
                isArchived: false,
            })
                .select('fromUserId toUserId')
                .lean();

            const connectedUserIds = Array.from(
                new Set(
                    connections.map((c: any) =>
                        c.fromUserId === userId ? c.toUserId : c.fromUserId
                    )
                )
            );

            if (connectedUserIds.length === 0) {
                return [];
            }

            // 2. Un connected users ka basic info + DOB fetch karo (single bulk query)
            const users = await User.find({
                userId: { $in: connectedUserIds },
                status: 'active',
            })
                .select('userId firstName lastName profilePhotoId')
                .lean();

            // 3. Un users ki current (ongoing) experience fetch karo (single bulk query)
            const experiences = await Experience.find({
                userId: { $in: connectedUserIds },
                isDeleted: false,
                currentlyWorking: true,
            })
                .select('userId currentPosition companyName startDate')
                .lean();

            const usersMap = new Map(users.map((u: any) => [u.userId, u]));
            const items: CatchUpItem[] = [];

            // 4. Job changes + Work anniversaries — Experience.startDate se
            for (const exp of experiences as any[]) {
                const user = usersMap.get(exp.userId);
                if (!user) continue;

                const startDate = new Date(exp.startDate);
                const daysSinceStart =
                    (today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);

                // Recent job change
                if (daysSinceStart >= 0 && daysSinceStart <= JOB_CHANGE_WINDOW_DAYS) {
                    items.push({
                        type: 'job_change',
                        userId: user.userId,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        profilePhotoId: user.profilePhotoId || null,
                        companyName: exp.companyName,
                        position: exp.currentPosition,
                        eventDate: startDate.toISOString(),
                    });
                    continue; // day-0 wale ko anniversary mein dobara mat dikhao
                }

                // Work anniversary — sirf jab month/day aaj se match kare aur >=1 saal ho gaya ho
                if (isSameMonthDay(startDate, today)) {
                    const years = diffYears(startDate, today);
                    if (years >= 1) {
                        items.push({
                            type: 'work_anniversary',
                            userId: user.userId,
                            firstName: user.firstName,
                            lastName: user.lastName,
                            profilePhotoId: user.profilePhotoId || null,
                            companyName: exp.companyName,
                            position: exp.currentPosition,
                            years,
                            eventDate: today.toISOString(),
                        });
                    }
                }
            }

            // 5. Birthdays — Contact.birthday se
            const contacts = await Contact.find({
                userId: { $in: connectedUserIds },
                isDeleted: false,
                isArchived: false,
            })
                .select('userId birthday')
                .lean();

            const contactsMap = new Map(contacts.map((c: any) => [c.userId, c]));

            const kolkataDateStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            const [todayYear, todayMonth, todayDay] = kolkataDateStr.split('-').map(Number);
            const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
            const isFeb28NonLeap = todayMonth === 2 && todayDay === 28 && !isLeapYear(todayYear);

            for (const user of users as any[]) {
                const contact = contactsMap.get(user.userId) as any;
                if (!contact || !contact.birthday) continue;

                const bMonth = contact.birthday.month;
                const bDay = contact.birthday.day;

                const isBirthdayToday =
                    (bMonth === todayMonth && bDay === todayDay) ||
                    (isFeb28NonLeap && bMonth === 2 && bDay === 29);

                if (isBirthdayToday) {
                    items.push({
                        type: 'birthday',
                        userId: user.userId,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        profilePhotoId: user.profilePhotoId || null,
                        eventDate: today.toISOString(),
                    });
                }
            }

            LoggerUtil.debug('Catch up feed generated', {
                userId,
                itemCount: items.length,
            });

            return items;
        } catch (error: any) {
            LoggerUtil.error('Failed to generate catch up feed', {
                error: error.message,
                userId,
            });
            throw error;
        }
    }
}

export default CatchUpService;