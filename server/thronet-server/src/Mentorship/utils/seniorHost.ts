// src/Mentorship/utils/seniorHost.ts
import { Mentor } from '../models';
import { resolveUserDetails } from './userPhotoHelper';
import { logger } from '@/shared/logger.util';

export interface SeniorSessionHost {
  userId: string;
  name: string;
  profilePic: string | null;
  role: string;
  headline: string;
}

/**
 * Mongoose doc ho ya plain object, dono ko same JSON shape mein convert karta hai
 * (toJSON transform se sessionId wali shape aur id field wahi rehti hai).
 */
const toPlain = (session: any): any =>
  typeof session?.toJSON === 'function' ? session.toJSON() : { ...session };

/**
 * Senior session ka mentorId = mentor ka userId (createSession mein userId hi set hota hai).
 * Isse bulk mein name + photo resolve karte hain, aur agar standard Mentor profile hai
 * to usse role/headline bhi lete hain. Koi N+1 query nahi.
 */
export async function buildHostMap(
  mentorIds: (string | undefined)[]
): Promise<Map<string, SeniorSessionHost>> {
  const hostMap = new Map<string, SeniorSessionHost>();

  const ids = Array.from(
    new Set(mentorIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
  );
  if (ids.length === 0) return hostMap;

  try {
    const details = await resolveUserDetails(ids);

    // Optional: standard Mentor profile se role/headline/photo fallback
    const mentorByKey = new Map<string, any>();
    try {
      const mentors = await Mentor.find({
        $or: [{ userId: { $in: ids } }, { mentorId: { $in: ids } }],
        isDeleted: false,
      })
        .select('userId mentorId title profilePic experience')
        .lean();

      (mentors as any[]).forEach((m) => {
        if (m.userId) mentorByKey.set(String(m.userId), m);
        if (m.mentorId) mentorByKey.set(String(m.mentorId), m);
      });
    } catch (err: any) {
      logger.warn(`[seniorHost] Mentor lookup warning: ${err?.message}`);
    }

    ids.forEach((id) => {
      const info = details.get(id);
      const mentor = mentorByKey.get(id);

      // resolveUserDetails user na milne par "User" bhejta hai, usse real naam mat samjho
      const name = info?.user ? info.name : '';
      const profilePic = info?.photoUrl || mentor?.profilePic || null;
      const role = mentor?.experience?.currentRole || mentor?.title || '';

      hostMap.set(id, {
        userId: info?.userId || id,
        name,
        profilePic,
        role,
        headline: role,
      });
    });
  } catch (err: any) {
    logger.error('[seniorHost] Failed to build host map:', err);
  }

  return hostMap;
}

/**
 * Sessions ki list ke saath har session mein `host` object jodta hai.
 * Host na mile to host: null jata hai (frontend fallback sambhal lega).
 */
export async function attachHosts(sessions: any[]): Promise<any[]> {
  const plain = (sessions || []).map(toPlain);
  const hostMap = await buildHostMap(plain.map((s) => s.mentorId));

  return plain.map((s) => ({ ...s, host: hostMap.get(s.mentorId) ?? null }));
}