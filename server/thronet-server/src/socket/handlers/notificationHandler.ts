import { Server, Socket } from 'socket.io';
import logger, { LogCategory } from '@/shared/logger.util';
import { AuthenticatedSocket } from '../index';
import { Notification } from '@/Mentorship/models';

export const setupNotificationHandlers = (io: Server, socket: AuthenticatedSocket) => {
    const userId = socket.data.userId;
    if (!userId) return;

      // Mark one notification as read
      socket.on('notification:read', async (data: { notificationId: string }) => {
        try {
            if (!data?.notificationId) return;
            await Notification.findOneAndUpdate(
                { notificationId: data.notificationId, userId },
                { $set: { 'status.read': true, 'status.readAt': new Date() } }
            );
            const count = await Notification.countDocuments({ userId, 'status.read': false });
            // Saare tabs/devices sync (sirf isi socket ko nahi)
            emitNotificationCount(io, userId, count);
        } catch (err) {
            logger.error('notification:read failed', err);
        }
    });

    // Mark ALL as read
    socket.on('notification:read:all', async () => {
        try {
            await Notification.updateMany(
                { userId, 'status.read': false },
                { $set: { 'status.read': true, 'status.readAt': new Date() } }
            );
            emitNotificationCount(io, userId, 0);
        } catch (err) {
            logger.error('notification:read:all failed', err);
        }
    });
    

    // Get unread count on connect
    socket.on('notification:get:unread:count', async () => {
        try {
            const count = await Notification.countDocuments({ userId, 'status.read': false });
            socket.emit('notification:unread:count', { count });
        } catch (err) { /* non-critical */ }
    });

    // Emit unread count immediately on connect
    setImmediate(async () => {
        try {
            const count = await Notification.countDocuments({ userId, 'status.read': false });
            socket.emit('notification:unread:count', { count });
        } catch (_) { }
    });
};

// ✅ Emit notification count update
export const emitNotificationCount = (
    io: Server,
    userId: string,
    count: number
) => {
    io.to(`user:${userId}`).emit('notification:unread:count', { count });

    logger.debug('Notification count emitted', {
        category: LogCategory.CONNECTION,
        data: { userId, count },
    });
};