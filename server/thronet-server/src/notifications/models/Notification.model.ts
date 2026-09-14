import mongoose, { Schema, Document, Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

export interface INotification extends Document {
    notificationId: string;
    recipientId: string;       // who receives it
    senderId: string;          // who triggered it
    senderName: string;
    senderPhoto?: string;
    type: 'post_created' | 'post_liked' | 'post_commented' | 'post_reposted' | 'connection_request' | 'connection_accepted' | 'mentioned' | 'new_follower' | 'profile_viewed' | 'birthday' | 'connection_birthday' | 'work_anniversary' | 'pymk_suggestion' | 'comment_liked' | 'comment_replied';
    entityId: string;         
    entityIds?: string[];
    entityType: 'post' | 'connection' | 'comment' | 'user';
    message: string;
    isRead: boolean;
    idempotencyKey?: string;
    createdAt: Date;
}

export interface INotificationModel extends Model<INotification> { }

const NotificationSchema = new Schema<INotification, INotificationModel>(
    {
        notificationId: { type: String, default: () => uuidv4(), unique: true },
        recipientId: { type: String, required: true },
        senderId: { type: String, required: true },
        senderName: { type: String, required: true },
        senderPhoto: { type: String, default: null },
        type: {
            type: String,
            enum: ['post_created', 'post_liked', 'post_commented', 'post_reposted', 'connection_request', 'connection_accepted', 'mentioned', 'new_follower', 'profile_viewed', 'birthday', 'connection_birthday', 'work_anniversary', 'pymk_suggestion', 'comment_liked', 'comment_replied'],
            required: true,
        },
        entityId: { type: String, required: true },
        entityIds: { type: [String], default: [] },
        entityType: { type: String, enum: ['post', 'connection', 'comment', 'user'], required: true },
        message: { type: String, required: true },
        isRead: { type: Boolean, default: false },
        idempotencyKey: { type: String, default: null },
    },
    { timestamps: true, collection: 'notifications-service' }
);

NotificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });
NotificationSchema.index(
    { idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            idempotencyKey: { $type: 'string' },
        },
    }
);

const Notification = mongoose.model<INotification, INotificationModel>('Notification-service', NotificationSchema);
export default Notification;