import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IPymkNotificationState extends Document {
    userId: string;
    lastNotifiedAt: Date | null;
    notifiedSuggestionIds: string[];
}

export interface IPymkNotificationStateModel extends Model<IPymkNotificationState> { }

const PymkNotificationStateSchema = new Schema<IPymkNotificationState, IPymkNotificationStateModel>(
    {
        userId: { type: String, required: true, unique: true, index: true },
        lastNotifiedAt: { type: Date, default: null },
        notifiedSuggestionIds: { type: [String], default: [] },
    },
    { timestamps: true, collection: 'pymk_notification_states' }
);

const PymkNotificationState = mongoose.model<IPymkNotificationState, IPymkNotificationStateModel>('PymkNotificationState', PymkNotificationStateSchema);
export default PymkNotificationState;
