import mongoose from 'mongoose';
import NotificationService from './src/notifications/services/notification.service';
import User from './src/auth/models/User.model';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/throne8');
        console.log('Connected to DB');

        const user = await User.findOne({ firstName: 'Anjali' });
        if (!user) {
            console.log('User Anjali not found');
            return;
        }

        console.log('Testing notification for userId:', user.userId);
        
        await NotificationService.notifyFollowersOnPost(
            user.userId,
            'test-entry-id',
            'Test Title'
        );
        
        console.log('Done testing.');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
run();
