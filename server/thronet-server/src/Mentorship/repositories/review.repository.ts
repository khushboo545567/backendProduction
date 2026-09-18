import MentorshipReview from '../models/MentorshipReview';
import mongoose from 'mongoose';

// ✅ FIX: mongoose.model('User') / .model('Mentor') / .model('ProfilePhoto')
// are called without a generic type, so TS treats every .lean() result as
// FlattenMaps<any> — it has no idea these documents carry firstName,
// profilePhotoId, etc. These lightweight interfaces describe just the
// fields this repository actually reads, and every lean() call below is
// cast against them so TS stops erroring on property access.
interface LeanUser {
    _id?: any;
    userId?: string;
    firstName?: string;
    lastName?: string;
    profilePhotoId?: string;
}

interface LeanMentor {
    userId?: string;
    profilePic?: string;
}

interface LeanPhoto {
    photoId?: string;
    cloudinarySecureUrl?: string;
    cloudinaryUrl?: string;
}

// ✅ FIX: MentorshipReview's schema doesn't declare `mentee`/`mentor` —
// those are attached dynamically below as enrichment. Reviews are typed
// as EnrichedReview (schema fields + optional enrichment) instead of the
// strict Mongoose lean type so those assignments type-check.
interface EnrichedReview {
    [key: string]: any;
    menteeId?: string;
    mentorId?: string;
    mentee?: {
        firstName?: string;
        lastName?: string;
        profilePhotoId?: string | null;
    };
    mentor?: {
        firstName?: string;
        lastName?: string;
        profilePhotoId?: string | null;
    };
}

class ReviewRepository {

    async findByReviewId(reviewId: string): Promise<any | null> {
        return await MentorshipReview.findOne({ reviewId, isDeleted: false });
    }

    async findById(objectId: string): Promise<any | null> {
        return await MentorshipReview.findById(objectId);
    }

    async findBySessionId(sessionId: string): Promise<any | null> {
        return await MentorshipReview.findOne({ sessionId, isDeleted: false });
    }

    async create(data: any): Promise<any> {
        const review = new MentorshipReview(data);
        await review.save();
        return review;  // instance methods chahiye
    }

    async findByMentorId(
        mentorId: string,
        skip: number,
        limit: number,
        includePrivate: boolean = false
    ): Promise<any[]> {
        const query: any = { mentorId, isDeleted: false };
        if (!includePrivate) query.isPublic = true;

        const reviews: EnrichedReview[] = await MentorshipReview.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        if (reviews.length > 0) {
            const User = mongoose.model('User');

            const uniqueMenteeIds = [...new Set(reviews.map(r => r.menteeId).filter(Boolean))];

            const mentor = await mongoose.model('Mentor')
                .findOne({ mentorId }, { userId: 1, profilePic: 1 })
                .lean() as LeanMentor | null;

            let mentorUser: LeanUser | null = null;
            if (mentor && mentor.userId) {
                mentorUser = await User.findOne(
                    { userId: mentor.userId },
                    { firstName: 1, lastName: 1, profilePhotoId: 1 }
                ).lean() as LeanUser | null;
            }

            const validMenteeIds = uniqueMenteeIds.filter(Boolean) as string[];

            let users: LeanUser[] = [];
            let photos: LeanPhoto[] = [];
            if (validMenteeIds.length > 0) {
                const objectIds = validMenteeIds.filter(id => mongoose.Types.ObjectId.isValid(id));
                const uuids = validMenteeIds.filter(id => !mongoose.Types.ObjectId.isValid(id));

                const orConditions: any[] = [];
                if (objectIds.length > 0) orConditions.push({ _id: { $in: objectIds } });
                if (uuids.length > 0) orConditions.push({ userId: { $in: uuids } });

                if (orConditions.length > 0) {
                    users = await User.find(
                        { $or: orConditions },
                        { userId: 1, firstName: 1, lastName: 1, profilePhotoId: 1 }
                    ).lean() as LeanUser[];

                    const photoIds = users.map(u => u.profilePhotoId).filter(Boolean) as string[];
                    if (mentorUser && mentorUser.profilePhotoId && !mentor?.profilePic) {
                        photoIds.push(mentorUser.profilePhotoId);
                    }

                    if (photoIds.length > 0) {
                        const ProfilePhoto = mongoose.model('ProfilePhoto');
                        photos = await ProfilePhoto.find(
                            { photoId: { $in: photoIds }, isDeleted: false },
                            { photoId: 1, cloudinarySecureUrl: 1, cloudinaryUrl: 1 }
                        ).lean() as LeanPhoto[];
                    }
                }
            }

            const userMap = new Map<string, LeanUser>();
            users.forEach((u) => {
                if (u.userId) userMap.set(u.userId, u);
                if (u._id) userMap.set(u._id.toString(), u);
            });

            const photoMap = new Map<string, string | undefined>();
            photos.forEach((p) => {
                if (p.photoId) photoMap.set(p.photoId, p.cloudinarySecureUrl || p.cloudinaryUrl);
            });

            reviews.forEach(review => {
                const user = review.menteeId ? userMap.get(review.menteeId) : undefined;
                if (user) {
                    review.mentee = {
                        firstName: user.firstName,
                        lastName: user.lastName,
                        profilePhotoId: user.profilePhotoId ? (photoMap.get(user.profilePhotoId) || user.profilePhotoId) : null
                    };
                }

                if (mentorUser) {
                    review.mentor = {
                        firstName: mentorUser.firstName,
                        lastName: mentorUser.lastName,
                        profilePhotoId: mentor?.profilePic || (mentorUser.profilePhotoId ? (photoMap.get(mentorUser.profilePhotoId) || mentorUser.profilePhotoId) : null)
                    };
                }
            });
        }

        return reviews;
    }

    async countByMentorId(
        mentorId: string,
        includePrivate: boolean = false
    ): Promise<number> {
        const query: any = { mentorId, isDeleted: false };
        if (!includePrivate) query.isPublic = true;
        return await MentorshipReview.countDocuments(query);
    }

    async getAverageRating(mentorId: string): Promise<any> {
        return await MentorshipReview.getAverageRating(mentorId);
    }

        async findByMenteeId(menteeId: string): Promise<any[]> {
        return await MentorshipReview.find({ menteeId, isDeleted: false })
            .sort({ createdAt: -1 })
            .lean();
    }

    // ✅ Repository mein atomic fix add karo
    async incrementHelpfulAtomic(reviewId: string): Promise<any> {
        return await MentorshipReview.findOneAndUpdate(
            { reviewId, isDeleted: false },
            { $inc: { helpfulCount: 1 } },
            { new: true }
        );
    }

    async incrementReportAtomic(reviewId: string): Promise<any> {
        return await MentorshipReview.findOneAndUpdate(
            { reviewId, isDeleted: false },
            { $inc: { reportCount: 1 } },
            { new: true }
        );
    }

}

export default new ReviewRepository();