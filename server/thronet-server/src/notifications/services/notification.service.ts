import { v4 as uuidv4 } from 'uuid';
import Notification, { INotification } from '../models/Notification.model';
import { getIO } from '@/socket';
import { LoggerUtil as logger } from '@/shared/logger.util';
import Connection from '@/connections/models/Connection';
import User from '@/auth/models/User.model';
import { Follow } from '@/connections/models/Follow';
import ProfilePhoto from '@/Profile/models/ProfilePhoto.model';

class NotificationService {

    /**
     * Unified post notification.
     * Notifies ALL followers + ALL accepted connections of the poster.
     * Recipients who belong to both groups receive only ONE notification.
     */
    static async notifyPostRecipients(
        posterId: string,
        entryId: string,
        _postTitle: string
    ): Promise<void> {
        try {
            // ── 1. Poster profile ──────────────────────────────────────────
            const poster = await User.findOne({ userId: posterId })
                .select('firstName lastName profilePhotoId')
                .lean();
            if (!poster) return;

            const posterName = `${poster.firstName} ${(poster as any).lastName || ''}`.trim();

            // Resolve real Cloudinary URL (profilePhotoId is a UUID reference, not a URL)
            let posterPhoto: string | null = null;
            if ((poster as any).profilePhotoId) {
                const photoDoc = await ProfilePhoto.findOne({
                    photoId: (poster as any).profilePhotoId,
                }).select('cloudinarySecureUrl').lean();
                posterPhoto = (photoDoc as any)?.cloudinarySecureUrl || null;
            }

            // ── 2. Fetch followers + connections in parallel ───────────────
            const [followers, connections] = await Promise.all([
                Follow.find({
                    followingId: posterId,
                    status: 'active',
                    isBlocked: false,
                }).select('followerId').lean(),

                Connection.find({
                    $or: [{ fromUserId: posterId }, { toUserId: posterId }],
                    status: 'active',
                    isArchived: false,
                }).select('fromUserId toUserId').lean(),
            ]);

            const followerIds: string[] = followers.map((f: any) => f.followerId);
            const connectionIds: string[] = connections.map((c: any) =>
                c.fromUserId === posterId ? c.toUserId : c.fromUserId
            );

            console.log(`[POST NOTIFICATION] Post ID: ${entryId}`);
            console.log(`[POST NOTIFICATION] Post Author ID: ${posterId}`);
            console.log(`[FOLLOWERS] Followers found: ${followerIds.length}`);
            console.log(`[FOLLOWERS] Follower IDs: ${JSON.stringify(followerIds)}`);
            console.log(`[CONNECTIONS] Connections found: ${connectionIds.length}`);
            console.log(`[CONNECTIONS] Connected User IDs: ${JSON.stringify(connectionIds)}`);

            // ── 3. Merge + deduplicate across both groups ──────────────────
            const allRecipientIds = [...new Set([...followerIds, ...connectionIds])];

            // Remove the poster themselves from recipients (safety guard)
            const candidateIds = allRecipientIds.filter((id) => id !== posterId);

            console.log(`[RECIPIENTS] Total recipients (after dedup): ${candidateIds.length}`);

            if (!candidateIds.length) return;

            // ── 4. Guard against re-insertion (e.g. retry) ────────────────
            const existingNotifs = await Notification.find({
                entityId: entryId,
                type: 'post_created',
                recipientId: { $in: candidateIds },
            }).select('recipientId').lean();

            const alreadyNotified = new Set(existingNotifs.map((n: any) => n.recipientId));
            const recipientIds = candidateIds.filter((id) => !alreadyNotified.has(id));

            console.log(`[NOTIFICATION] Already notified: ${alreadyNotified.size}`);
            console.log(`[NOTIFICATION] New notifications to create: ${recipientIds.length}`);

            if (!recipientIds.length) return;

            // ── 5. Build and insert notification documents ────────────────
            const message = `${posterName} created a new post.`;

            const docs = recipientIds.map((recipientId: string) => {
                const doc: any = {
                    notificationId: uuidv4(),
                    recipientId,
                    senderId: posterId,
                    senderName: posterName,
                    type: 'post_created',
                    entityId: entryId,
                    entityType: 'post',
                    message,
                    isRead: false,
                };
                if (posterPhoto) doc.senderPhoto = posterPhoto;
                return doc;
            });

            await Notification.insertMany(docs, { ordered: false });
            console.log(`[NOTIFICATION] Notifications saved: ${docs.length}`);

            // ── 6. Real-time Socket.IO emit ────────────────────────────────
            try {
                const io = getIO();
                recipientIds.forEach((recipientId: string) => {
                    const payload = {
                        notificationId: docs.find((d: any) => d.recipientId === recipientId)?.notificationId,
                        type: 'post_created',
                        senderId: posterId,
                        senderName: posterName,
                        senderPhoto: posterPhoto,
                        entityId: entryId,
                        entityType: 'post',
                        message,
                        isRead: false,
                        createdAt: new Date().toISOString(),
                    };
                    console.log(`[SOCKET] Emitting notification:new → user:${recipientId}`);
                    io.to(`user:${recipientId}`).emit('notification:new', payload);
                });
                console.log(`[SOCKET] notification:new emitted to ${recipientIds.length} recipients`);
            } catch (socketErr) {
                // Socket is non-critical — DB record already saved
                logger.warn('Socket emit failed for post notifications', {
                    error: socketErr instanceof Error ? socketErr.message : 'unknown',
                });
            }

            logger.info('Post notifications sent', {
                posterId,
                entryId,
                followerCount: followerIds.length,
                connectionCount: connectionIds.length,
                uniqueRecipientCount: recipientIds.length,
            });
        } catch (err) {
            logger.error('notifyPostRecipients failed', {
                error: err instanceof Error ? err.message : 'unknown',
                posterId,
                entryId,
            });
        }
    }

    /**
     * @deprecated Use notifyPostRecipients instead.
     * Kept for backward compatibility — delegates to the unified function.
     */
    static async notifyFollowersOnPost(
        posterId: string,
        entryId: string,
        postTitle: string
    ): Promise<void> {
        return NotificationService.notifyPostRecipients(posterId, entryId, postTitle);
    }

    /**
     * @deprecated Use notifyPostRecipients instead.
     * Kept for backward compatibility — delegates to the unified function.
     */
    static async notifyConnectionsOnPost(
        posterId: string,
        entryId: string,
        postTitle: string
    ): Promise<void> {
        return NotificationService.notifyPostRecipients(posterId, entryId, postTitle);
    }

    ////////Changed Modified
    /**
         * Called after a post is liked.
         * Notifies the post owner (unless they liked their own post).
         */
    static async notifyPostLiked(
        postOwnerId: string,
        likerId: string,
        entryId: string,
        postTitle?: string
    ): Promise<void> {
        try {
            if (postOwnerId === likerId) return; // don't notify yourself

            const liker = await User.findOne({ userId: likerId }).select('firstName lastName profilePhotoId').lean();
            if (!liker) return;

            const likerName = `${liker.firstName} ${liker.lastName || ''}`.trim();
            let likerPhoto: string | null = null;
            if (liker.profilePhotoId) {
                const photoDoc = await ProfilePhoto.findOne({
                    photoId: liker.profilePhotoId,
                }).select('cloudinarySecureUrl').lean();
                likerPhoto = (photoDoc as any)?.cloudinarySecureUrl || null;
            }

            const shortTitle = postTitle ? `"${postTitle.slice(0, 60)}${postTitle.length > 60 ? '...' : ''}"` : 'your post';
            const message = `${likerName} liked ${shortTitle}`;

            const notificationId = uuidv4();

            await Notification.create({
                notificationId,
                recipientId: postOwnerId,
                senderId: likerId,
                senderName: likerName,
                senderPhoto: likerPhoto,
                type: 'post_liked',
                entityId: entryId,
                entityType: 'post',
                message,
                isRead: false,
            });

            try {
                const io = getIO();
                io.to(`user:${postOwnerId}`).emit('notification:new', {
                    notificationId,
                    type: 'post_liked',
                    senderId: likerId,
                    senderName: likerName,
                    senderPhoto: likerPhoto,
                    entityId: entryId,
                    entityType: 'post',
                    message,
                    isRead: false,
                    createdAt: new Date().toISOString(),
                });
            } catch (socketErr) {
                logger.warn('Socket emit failed for like notification', {
                    error: socketErr instanceof Error ? socketErr.message : 'unknown',
                });
            }

            logger.info('Like notification sent', { postOwnerId, likerId, entryId });
        } catch (err) {
            logger.error('notifyPostLiked failed', {
                error: err instanceof Error ? err.message : 'unknown',
                postOwnerId,
                likerId,
                entryId,
            });
        }
    }

    ////////////////////////////////Changed Modified
    /**
     * Called after a comment is added to a post.
     * Notifies the post owner (unless they commented on their own post).
     */
    static async notifyPostCommented(
        postOwnerId: string,
        commenterId: string,
        entryId: string,
        postTitle?: string,
        commentContent?: string
    ): Promise<void> {
        try {
            if (postOwnerId === commenterId) return; // don't notify yourself

            const commenter = await User.findOne({ userId: commenterId }).select('firstName lastName profilePhotoId').lean();
            if (!commenter) return;

            const commenterName = `${commenter.firstName} ${commenter.lastName || ''}`.trim();
            let commenterPhoto: string | null = null;
            if (commenter.profilePhotoId) {
                const photoDoc = await ProfilePhoto.findOne({
                    photoId: commenter.profilePhotoId,
                }).select('cloudinarySecureUrl').lean();
                commenterPhoto = (photoDoc as any)?.cloudinarySecureUrl || null;
            }

            const shortTitle = postTitle ? `"${postTitle.slice(0, 60)}${postTitle.length > 60 ? '...' : ''}"` : 'your post';
            const message = `${commenterName} commented on ${shortTitle}`;

            const notificationId = uuidv4();

            await Notification.create({
                notificationId,
                recipientId: postOwnerId,
                senderId: commenterId,
                senderName: commenterName,
                senderPhoto: commenterPhoto,
                type: 'post_commented',
                entityId: entryId,
                entityType: 'post',
                message,
                isRead: false,
            });

            try {
                const io = getIO();
                io.to(`user:${postOwnerId}`).emit('notification:new', {
                    notificationId,
                    type: 'post_commented',
                    senderId: commenterId,
                    senderName: commenterName,
                    senderPhoto: commenterPhoto,
                    entityId: entryId,
                    entityType: 'post',
                    message,
                    isRead: false,
                    createdAt: new Date().toISOString(),
                });
            } catch (socketErr) {
                logger.warn('Socket emit failed for comment notification', {
                    error: socketErr instanceof Error ? socketErr.message : 'unknown',
                });
            }

            logger.info('Comment notification sent', { postOwnerId, commenterId, entryId });
        } catch (err) {
            logger.error('notifyPostCommented failed', {
                error: err instanceof Error ? err.message : 'unknown',
                postOwnerId,
                commenterId,
                entryId,
            });
        }
    }


    ////////////////////////////////Changed Modified
    /**
     * Called after someone is @mentioned in a post or comment.
     * Notifies the mentioned user (unless they mentioned themselves).
     */
    static async notifyMentioned(
        mentionedUserId: string,
        mentionerId: string,
        entryId: string,
        contextTitle?: string,
        context: 'post' | 'comment' = 'post'
    ): Promise<void> {
        try {
            if (mentionedUserId === mentionerId) return; // don't notify yourself

            const mentioner = await User.findOne({ userId: mentionerId }).select('firstName lastName profilePhotoId').lean();
            if (!mentioner) return;

            const mentionerName = `${mentioner.firstName} ${mentioner.lastName || ''}`.trim();
            let mentionerPhoto: string | null = null;
            if (mentioner.profilePhotoId) {
                const photoDoc = await ProfilePhoto.findOne({
                    photoId: mentioner.profilePhotoId,
                }).select('cloudinarySecureUrl').lean();
                mentionerPhoto = (photoDoc as any)?.cloudinarySecureUrl || null;
            }

            const shortTitle = contextTitle ? `"${contextTitle.slice(0, 60)}${contextTitle.length > 60 ? '...' : ''}"` : 'a post';
            const message = context === 'comment'
                ? `${mentionerName} mentioned you in a comment on ${shortTitle}`
                : `${mentionerName} mentioned you in ${shortTitle}`;

            const notificationId = uuidv4();

            await Notification.create({
                notificationId,
                recipientId: mentionedUserId,
                senderId: mentionerId,
                senderName: mentionerName,
                senderPhoto: mentionerPhoto,
                type: 'mentioned',
                entityId: entryId,
                entityType: context,
                message,
                isRead: false,
            });

            try {
                const io = getIO();
                io.to(`user:${mentionedUserId}`).emit('notification:new', {
                    notificationId,
                    type: 'mentioned',
                    senderId: mentionerId,
                    senderName: mentionerName,
                    senderPhoto: mentionerPhoto,
                    entityId: entryId,
                    entityType: context,
                    message,
                    isRead: false,
                    createdAt: new Date().toISOString(),
                });
            } catch (socketErr) {
                logger.warn('Socket emit failed for mention notification', {
                    error: socketErr instanceof Error ? socketErr.message : 'unknown',
                });
            }

            logger.info('Mention notification sent', { mentionedUserId, mentionerId, entryId, context });
        } catch (err) {
            logger.error('notifyMentioned failed', {
                error: err instanceof Error ? err.message : 'unknown',
                mentionedUserId,
                mentionerId,
                entryId,
            });
        }
    }

    /**
     * Called when User A sends a connection request to User B.
     * Creates a persistent Notification for User B and emits notification:new.
     */
    static async notifyConnectionRequest(
        fromUserId: string,
        toUserId: string,
        requestId: string
    ): Promise<void> {
        try {
            if (fromUserId === toUserId) return;

            const sender = await User.findOne({ userId: fromUserId })
                .select('firstName lastName profilePhotoId')
                .lean();
            if (!sender) return;

            const senderName = `${sender.firstName} ${sender.lastName || ''}`.trim();
            let senderPhoto: string | null = null;
            if ((sender as any).profilePhotoId) {
                const photoDoc = await ProfilePhoto.findOne({
                    photoId: (sender as any).profilePhotoId,
                }).select('cloudinarySecureUrl').lean();
                senderPhoto = (photoDoc as any)?.cloudinarySecureUrl || null;
            }
            const message = `${senderName} sent you a connection request`;
            const notificationId = uuidv4();

            await Notification.create({
                notificationId,
                recipientId: toUserId,
                senderId: fromUserId,
                senderName,
                senderPhoto,
                type: 'connection_request' as const,
                entityId: requestId,
                entityType: 'connection' as const,
                message,
                isRead: false,
            });

            try {
                const io = getIO();
                io.to(`user:${toUserId}`).emit('notification:new', {
                    notificationId,
                    type: 'connection_request',
                    senderId: fromUserId,
                    senderName,
                    senderPhoto,
                    entityId: requestId,
                    entityType: 'connection',
                    message,
                    isRead: false,
                    createdAt: new Date().toISOString(),
                });
            } catch (socketErr) {
                logger.warn('Socket emit failed for connection_request notification', {
                    error: socketErr instanceof Error ? socketErr.message : 'unknown',
                });
            }

            logger.info('Connection request notification sent', { fromUserId, toUserId, requestId });
        } catch (err) {
            logger.error('notifyConnectionRequest failed', {
                error: err instanceof Error ? err.message : 'unknown',
                fromUserId,
                toUserId,
                requestId,
            });
        }
    }

    /**
     * Called when User B accepts User A's connection request.
     * Creates a persistent Notification for User A and emits notification:new.
     */
    static async notifyConnectionAccepted(
        acceptedByUserId: string,
        originalSenderId: string,
        connectionId: string
    ): Promise<void> {
        try {
            if (acceptedByUserId === originalSenderId) return;

            const acceptor = await User.findOne({ userId: acceptedByUserId })
                .select('firstName lastName profilePhotoId')
                .lean();
            if (!acceptor) return;

            const acceptorName = `${acceptor.firstName} ${acceptor.lastName || ''}`.trim();
            let acceptorPhoto: string | null = null;
            if ((acceptor as any).profilePhotoId) {
                const photoDoc = await ProfilePhoto.findOne({
                    photoId: (acceptor as any).profilePhotoId,
                }).select('cloudinarySecureUrl').lean();
                acceptorPhoto = (photoDoc as any)?.cloudinarySecureUrl || null;
            }
            const message = `${acceptorName} accepted your connection request`;
            const notificationId = uuidv4();

            await Notification.create({
                notificationId,
                recipientId: originalSenderId,
                senderId: acceptedByUserId,
                senderName: acceptorName,
                senderPhoto: acceptorPhoto,
                type: 'connection_accepted' as const,
                entityId: connectionId,
                entityType: 'connection' as const,
                message,
                isRead: false,
            });

            try {
                const io = getIO();
                io.to(`user:${originalSenderId}`).emit('notification:new', {
                    notificationId,
                    type: 'connection_accepted',
                    senderId: acceptedByUserId,
                    senderName: acceptorName,
                    senderPhoto: acceptorPhoto,
                    entityId: connectionId,
                    entityType: 'connection',
                    message,
                    isRead: false,
                    createdAt: new Date().toISOString(),
                });
            } catch (socketErr) {
                logger.warn('Socket emit failed for connection_accepted notification', {
                    error: socketErr instanceof Error ? socketErr.message : 'unknown',
                });
            }

            logger.info('Connection accepted notification sent', { acceptedByUserId, originalSenderId, connectionId });
        } catch (err) {
            logger.error('notifyConnectionAccepted failed', {
                error: err instanceof Error ? err.message : 'unknown',
                acceptedByUserId,
                originalSenderId,
                connectionId,
            });
        }
    }

    /** Fetch paginated notifications for a user */
    static async getNotifications(
        userId: string,
        page = 1,
        limit = 20
    ): Promise<{ notifications: INotification[]; unreadCount: number; total: number }> {
        const skip = (page - 1) * limit;

        const [notifications, unreadCount, total] = await Promise.all([
            Notification.find({ recipientId: userId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean<INotification>(),
            Notification.countDocuments({ recipientId: userId, isRead: false }),
            Notification.countDocuments({ recipientId: userId }),
        ]);

        return { notifications, unreadCount, total };
    }

    /** Mark one notification as read */
    static async markAsRead(notificationId: string, userId: string): Promise<void> {
        await Notification.updateOne(
            { notificationId, recipientId: userId },
            { $set: { isRead: true } }
        );
    }

    /** Mark all notifications as read */
    static async markAllAsRead(userId: string): Promise<void> {
        await Notification.updateMany(
            { recipientId: userId, isRead: false },
            { $set: { isRead: true } }
        );
    }

    /** Delete a notification */
    static async deleteNotification(notificationId: string, userId: string): Promise<void> {
        await Notification.deleteOne({ notificationId, recipientId: userId });
    }
}

export default NotificationService;