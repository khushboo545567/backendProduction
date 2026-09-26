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
    title?: string;
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

    menteeId?: string | { userId?: string; _id?: any };
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
                    { firstName: 1, lastName: 1, profilePhotoId: 1, title: 1 }
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
                        { userId: 1, firstName: 1, lastName: 1, profilePhotoId: 1, title: 1 }
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

            // Fetch session info if uniqueSessionIds exist
            const uniqueSessionIds = [...new Set(reviews.map(r => r.sessionId).filter(Boolean))];
            let sessionMap = new Map<string, any>();
            if (uniqueSessionIds.length > 0) {
                try {
                    const SessionMentor = mongoose.model('SessionMentor');
                    const sessions = await SessionMentor.find(
                        { sessionId: { $in: uniqueSessionIds } },
                        { sessionId: 1, title: 1, sessionType: 1, scheduledAt: 1 }
                    ).lean();
                    sessions.forEach((s: any) => {
                        if (s.sessionId) sessionMap.set(s.sessionId, s);
                    });
                } catch (e) {
                    // silent fallback if SessionMentor query fails
                }
            }

            reviews.forEach(review => {
                const rawMenteeId = typeof review.menteeId === 'string'
                    ? review.menteeId
                    : (review.menteeId?.userId || review.menteeId?._id);
                const user = rawMenteeId ? userMap.get(rawMenteeId as unknown as string) : undefined;
                
                if (user) {
                    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
                    const profilePic = user.profilePhotoId ? (photoMap.get(user.profilePhotoId) || user.profilePhotoId) : null;
                    
                    review.mentee = {
                        firstName: user.firstName,
                        lastName: user.lastName,
                        fullName: fullName || "Mentee",
                        name: fullName || "Mentee",
                        profilePic: profilePic,
                        profilePhotoId: profilePic,
                        title: user.title,
                    } as any;
                    review.menteeId = {
                        userId: user.userId || (user._id ? user._id.toString() : rawMenteeId),
                        fullName: fullName || "Mentee",
                        name: fullName || "Mentee",
                        profilePic: profilePic,
                        title: user.title,
                    } as any;
                }

                if (mentorUser) {
                    review.mentorId = {
                        fullName: `${mentorUser.firstName || ''} ${mentorUser.lastName || ''}`.trim(),
                        profilePic: mentor?.profilePic || (mentorUser.profilePhotoId ? (photoMap.get(mentorUser.profilePhotoId) || mentorUser.profilePhotoId) : null),
                        title: mentorUser.title
                    } as any;
                }

                if (review.sessionId && sessionMap.has(review.sessionId)) {
                    const sess = sessionMap.get(review.sessionId);
                    review.session = {
                        title: sess.title,
                        sessionType: sess.sessionType,
                        scheduledAt: sess.scheduledAt,
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