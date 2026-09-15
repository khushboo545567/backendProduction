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
            await Notification.findOneAndUpdate(
                { notificationId: data.notificationId, userId },
                { $set: { 'status.read': true, 'status.readAt': new Date() } }
            );
            // Send updated count
            const count = await Notification.countDocuments({ userId, 'status.read': false });
            socket.emit('notification:unread:count', { count });
        } catch (err) { /* non-critical */ }
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