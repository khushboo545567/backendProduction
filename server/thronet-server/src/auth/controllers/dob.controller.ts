// src/auth/controllers/dob.controller.ts
import { Request, Response } from 'express';
import { User, Contact } from '@/shared/models/index.models';
import Connection from '@/connections/models/Connection';
import NotificationService from '@/notifications/services/notification.service';
import ResponseUtil from '@/shared/response.util';
import LoggerUtil from '@/shared/logger.util';
import { v4 as uuidv4 } from 'uuid';

interface UpdateDobBody {
    dateOfBirth: string; // format: YYYY-MM-DD
}

/**
 * PATCH /auth/date-of-birth
 * Lets an authenticated user set/update their date of birth.
 * Needed so the Catch Up feed can show birthdays for their connections.
 */
export const updateDateOfBirth = async (
    req: Request<{}, any, UpdateDobBody>,
    res: Response
): Promise<void> => {
    const userId = (req as any).user?.id;
    const { dateOfBirth } = req.body;

    try {
        if (!userId) {
            ResponseUtil.unauthorized(res, 'Authentication required');
            return;
        }

        if (!dateOfBirth) {
            ResponseUtil.badRequest(res, 'dateOfBirth is required (format: YYYY-MM-DD)');
            return;
        }

        const parsedDate = new Date(dateOfBirth);
        if (isNaN(parsedDate.getTime())) {
            ResponseUtil.badRequest(res, 'Invalid date format. Use YYYY-MM-DD');
            return;
        }

        const ageYears = (Date.now() - parsedDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
        if (ageYears < 13 || ageYears > 120) {
            ResponseUtil.badRequest(res, 'Date of birth must indicate an age between 13 and 120');
            return;
        }

        // Use UTC to avoid timezone shifts changing the day
        const day = parsedDate.getUTCDate();
        const month = parsedDate.getUTCMonth() + 1;
        const year = parsedDate.getUTCFullYear();



        const user = await User.findOne({ userId });
        if (!user) {
            ResponseUtil.notFound(res, 'User not found');
            return;
        }

        // 1. Check if a Contact document already exists
        let contact = await Contact.findOne({ userId });
        
        if (contact) {
            // Update existing contact
            contact.birthday = { day, month, year, hideYear: false };
            await contact.save();
        } else {
            // Create new contact and link it back to User
            contact = new Contact({
                contactId: uuidv4(),
                userId,
                birthday: { day, month, year, hideYear: false }
            });
            await contact.save();
            
            // Set contactId on User
            user.contactId = contact.contactId;
            await user.save();
        }

        LoggerUtil.info('Date of birth updated', { userId });

        // 2. Trigger notification if birthday is today in Asia/Kolkata timezone
        const kolkataDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const [todayYear, todayMonth, todayDay] = kolkataDateStr.split('-').map(Number);
        
        const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
        const isFeb28NonLeap = todayMonth === 2 && todayDay === 28 && !isLeapYear(todayYear);
        
        const isBirthdayToday = (month === todayMonth && day === todayDay) || (isFeb28NonLeap && month === 2 && day === 29);
        
        if (isBirthdayToday) {
            try {
                const connections = await Connection.find({
                    $or: [{ fromUserId: userId }, { toUserId: userId }],
                    status: 'active',
                    isArchived: false,
                }).select('fromUserId toUserId').lean();

                const recipientIds = Array.from(
                    new Set(
                        connections
                            .map((c: any) => (c.fromUserId === userId ? c.toUserId : c.fromUserId))
                            .filter((id: string) => id && id !== userId)
                    )
                );

                if (recipientIds.length > 0) {
                    await NotificationService.notifyConnectionBirthdaysBatch(userId, recipientIds);
                    LoggerUtil.info('Immediate birthday notifications triggered', { userId, count: recipientIds.length });
                }
            } catch (notifError) {
                LoggerUtil.error('Failed to trigger immediate birthday notification', {
                    userId,
                    error: notifError instanceof Error ? notifError.message : String(notifError)
                });
                // We don't fail the request if notification fails
            }
        }

        ResponseUtil.success(
            res,
            { dateOfBirth: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` },
            'Date of birth updated successfully'
        );
        return;
    } catch (error: any) {
        LoggerUtil.error('Update date of birth failed', {
            error: error.message,
            userId,
        });
        ResponseUtil.error(res, error.message || 'Failed to update date of birth', 500);
        return;
    }
};

export default { updateDateOfBirth };