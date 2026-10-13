// src/Mentorship/utils/userPhotoHelper.ts
import mongoose from 'mongoose';
import { User, UserProfile } from '@/auth/models';
import ProfilePhoto from '@/Profile/models/ProfilePhoto.model';
import { logger } from '@/shared/logger.util';

export interface ResolvedUserInfo {
  userId: string;
  name: string;
  photoUrl: string | null;
  user?: any;
}

/**
 * Bulk resolves user profile photos across User, ProfilePhoto, and UserProfile collections
 * without N+1 queries.
 *
 * Checks in order of priority:
 * 1. user.profilePic (if it's already an HTTP URL)
 * 2. ProfilePhoto document matching user.profilePhotoId (cloudinarySecureUrl || cloudinaryUrl)
 * 3. ProfilePhoto document matching user.profilePic (if profilePic was saved as a photoId)
 * 4. Active ProfilePhoto document for user ({ userId, isActive: true, isDeleted: false })
 * 5. user.profilePhotoId (if it's already an HTTP URL)
 * 6. UserProfile avatar ({ avatar.url || avatar })
 *
 * @param rawUserIds Array of user identifiers (UUIDs, ObjectIds, string IDs)
 * @returns Map where keys are normalized user IDs / ObjectIds and values are photo URLs
 */
export async function resolveUserPhotos(rawUserIds: (string | any)[]): Promise<Map<string, string>> {
  const detailsMap = await resolveUserDetails(rawUserIds);
  const photoMap = new Map<string, string>();

  detailsMap.forEach((info, id) => {
    if (info.photoUrl) {
      photoMap.set(id, info.photoUrl);
    }
  });

  return photoMap;
}

/**
 * Bulk resolves user details (name and profile photo) without N+1 queries.
 */
export async function resolveUserDetails(rawUserIds: (string | any)[]): Promise<Map<string, ResolvedUserInfo>> {
  const resultMap = new Map<string, ResolvedUserInfo>();

  try {
    const cleanIds = Array.from(
      new Set(
        (rawUserIds || [])
          .filter(Boolean)
          .map((id) => (typeof id === 'object' && id?._id ? String(id._id) : String(id).trim()))
          .filter((id) => id.length > 0)
      )
    );

    if (cleanIds.length === 0) {
      return resultMap;
    }

    // 1. Query User collection in bulk
    const objectIds: mongoose.Types.ObjectId[] = [];
    cleanIds.forEach((id) => {
      if (mongoose.Types.ObjectId.isValid(id)) {
        try {
          objectIds.push(new mongoose.Types.ObjectId(id));
        } catch {
          // ignore invalid objectId conversion
        }
      }
    });

    const userOrConditions: any[] = [{ userId: { $in: cleanIds } }];
    if (objectIds.length > 0) {
      userOrConditions.push({ _id: { $in: objectIds } });
    }

    const users = await User.find(
      { $or: userOrConditions },
      { _id: 1, userId: 1, firstName: 1, lastName: 1, fullName: 1, username: 1, email: 1, profilePhotoId: 1, profilePic: 1 }
    ).lean();

    const userMap = new Map<string, any>();
    users.forEach((u: any) => {
      if (u.userId) userMap.set(String(u.userId), u);
      if (u._id) userMap.set(String(u._id), u);
    });

    // 2. Identify candidate photoIds and userIds for ProfilePhoto bulk lookup
    const photoIdsToQuery = new Set<string>();
    const userIdsToQuery = new Set<string>();

    cleanIds.forEach((id) => userIdsToQuery.add(id));

    users.forEach((u: any) => {
      if (u.userId) userIdsToQuery.add(String(u.userId));

      if (u.profilePhotoId && typeof u.profilePhotoId === 'string' && !u.profilePhotoId.startsWith('http')) {
        photoIdsToQuery.add(u.profilePhotoId);
      }
      if (u.profilePic && typeof u.profilePic === 'string' && !u.profilePic.startsWith('http')) {
        photoIdsToQuery.add(u.profilePic);
      }
    });

    // 3. Bulk query ProfilePhoto collection
    const photoOrConditions: any[] = [];
    if (photoIdsToQuery.size > 0) {
      photoOrConditions.push({ photoId: { $in: Array.from(photoIdsToQuery) } });
    }
    if (userIdsToQuery.size > 0) {
      photoOrConditions.push({ userId: { $in: Array.from(userIdsToQuery) }, isActive: true });
    }

    const photoByPhotoId = new Map<string, string>();
    const activePhotoByUserId = new Map<string, string>();

    if (photoOrConditions.length > 0) {
      try {
        const photoDocs = await ProfilePhoto.find(
          {
            $or: photoOrConditions,
            isDeleted: { $ne: true },
          },
          { photoId: 1, userId: 1, isActive: 1, cloudinarySecureUrl: 1, cloudinaryUrl: 1 }
        ).lean();

        photoDocs.forEach((p: any) => {
          const url = p.cloudinarySecureUrl || p.cloudinaryUrl || null;
          if (url) {
            if (p.photoId) photoByPhotoId.set(String(p.photoId), url);
            if (p.userId && p.isActive) activePhotoByUserId.set(String(p.userId), url);
          }
        });
      } catch (err: any) {
        logger.warn(`[resolveUserDetails] ProfilePhoto bulk lookup warning: ${err?.message}`);
      }
    }

    // 4. Fallback check UserProfile collection for any user still unresolved
    const unresolvedUserIds: string[] = [];
    users.forEach((u: any) => {
      const uId = u.userId ? String(u.userId) : null;
      if (!uId) return;

      const hasDirectPic = typeof u.profilePic === 'string' && u.profilePic.startsWith('http');
      const hasPhotoIdMatch = u.profilePhotoId && photoByPhotoId.has(String(u.profilePhotoId));
      const hasPicIdMatch = u.profilePic && photoByPhotoId.has(String(u.profilePic));
      const hasActivePhoto = activePhotoByUserId.has(uId);
      const hasDirectPhotoId = typeof u.profilePhotoId === 'string' && u.profilePhotoId.startsWith('http');

      if (!hasDirectPic && !hasPhotoIdMatch && !hasPicIdMatch && !hasActivePhoto && !hasDirectPhotoId) {
        unresolvedUserIds.push(uId);
      }
    });

    const userProfileAvatarMap = new Map<string, string>();
    if (unresolvedUserIds.length > 0) {
      try {
        const profiles = await UserProfile.find(
          { userId: { $in: unresolvedUserIds } },
          { userId: 1, avatar: 1 }
        ).lean();

        profiles.forEach((pr: any) => {
          const url = pr?.avatar?.url || (typeof pr?.avatar === 'string' ? pr.avatar : null);
          if (url && pr.userId) {
            userProfileAvatarMap.set(String(pr.userId), url);
          }
        });
      } catch (err: any) {
        logger.warn(`[resolveUserDetails] UserProfile fallback lookup warning: ${err?.message}`);
      }
    }

    // 5. Construct resolved details for each ID
    cleanIds.forEach((id) => {
      const user = userMap.get(id);

      const name = user
        ? (user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username || user.email || 'User')
        : 'User';

      let photoUrl: string | null = null;

      if (user) {
        if (typeof user.profilePic === 'string' && user.profilePic.startsWith('http')) {
          photoUrl = user.profilePic;
        } else if (user.profilePhotoId && photoByPhotoId.has(String(user.profilePhotoId))) {
          photoUrl = photoByPhotoId.get(String(user.profilePhotoId)) || null;
        } else if (user.profilePic && photoByPhotoId.has(String(user.profilePic))) {
          photoUrl = photoByPhotoId.get(String(user.profilePic)) || null;
        } else if (user.userId && activePhotoByUserId.has(String(user.userId))) {
          photoUrl = activePhotoByUserId.get(String(user.userId)) || null;
        } else if (typeof user.profilePhotoId === 'string' && user.profilePhotoId.startsWith('http')) {
          photoUrl = user.profilePhotoId;
        } else if (user.userId && userProfileAvatarMap.has(String(user.userId))) {
          photoUrl = userProfileAvatarMap.get(String(user.userId)) || null;
        }
      }

      // If user wasn't in User collection, try direct active photo or avatar lookup by raw ID
      if (!photoUrl) {
        if (activePhotoByUserId.has(id)) {
          photoUrl = activePhotoByUserId.get(id) || null;
        } else if (userProfileAvatarMap.has(id)) {
          photoUrl = userProfileAvatarMap.get(id) || null;
        } else if (photoByPhotoId.has(id)) {
          photoUrl = photoByPhotoId.get(id) || null;
        }
      }

      const info: ResolvedUserInfo = {
        userId: user?.userId || id,
        name,
        photoUrl,
        user,
      };

      resultMap.set(id, info);
      if (user?.userId) resultMap.set(String(user.userId), info);
      if (user?._id) resultMap.set(String(user._id), info);
    });

    return resultMap;
  } catch (error: any) {
    logger.error('[resolveUserDetails] Error resolving user details:', error);
    return resultMap;
  }
}
