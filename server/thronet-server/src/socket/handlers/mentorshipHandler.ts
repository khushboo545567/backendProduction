// src/socket/handlers/mentorshipHandler.ts

import { Server } from 'socket.io';
import { AuthenticatedSocket, emitToUser } from '../index';
import { SessionMentor, Mentor } from '@/Mentorship/models';
import notificationService, {
  NotificationType,
  NotificationChannel,
} from '@/Mentorship/services/notification.service';
import { LoggerUtil } from '@/shared/logger.util';

export const setupMentorshipHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const userId = socket.data.userId;
  if (!userId) return;

  socket.on('mentorship:notify-join', async (data: { sessionId: string }) => {
    try {
      const { sessionId } = data;
      if (!sessionId) return;

      const session = await SessionMentor.findOne({ sessionId });
      if (!session) {
        LoggerUtil.warn('mentorship:notify-join — session not found', { sessionId });
        return;
      }

      const mentor = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });
      const mentorUserId = mentor?.userId;

      // menteeId ya toh top-level field pe hai, ya bookings[] array me
      const confirmedBooking = session.bookings?.find((b: any) =>
        ['confirmed', 'in_progress', 'rescheduled'].includes(b.status)
      );
      const menteeUserId = session.menteeId || confirmedBooking?.menteeId || confirmedBooking?.bookedBy;

      let targetUserId: string | undefined;
      let joinerRole: 'mentor' | 'mentee' = 'mentee';

      if (userId === mentorUserId) {
        targetUserId = menteeUserId;
        joinerRole = 'mentor';
      } else {
        targetUserId = mentorUserId;
        joinerRole = 'mentee';
      }

      if (!targetUserId) {
        LoggerUtil.warn('mentorship:notify-join — target user not resolved', { sessionId, mentorUserId, menteeUserId });
        return;
      }

      // 1) Real-time signal — target abhi online ho tabhi kaam karega
      emitToUser(targetUserId, 'mentorship:peer-joined', {
        sessionId,
        joinerRole,
        title: session.title,
      });

      // 2) Persistent bell notification — offline hone par bhi save rahega
      await notificationService.sendNotification({
        userId: targetUserId,
        type: NotificationType.SESSION_STARTED,
        channels: [NotificationChannel.IN_APP],
        priority: 'high',
        data: {
          ...(joinerRole === 'mentee' && menteeUserId ? { menteeId: menteeUserId } : {}),
          title: `${joinerRole === 'mentor' ? 'Mentor' : 'Mentee'} joined the session`,
          message: `${joinerRole === 'mentor' ? 'Your mentor' : 'Your mentee'} has joined "${session.title || 'the session'}". Join now to start the call.`,
          sessionId,
          actionUrl: `/mentorship/session-room/${sessionId}?bookingId=${(confirmedBooking as any)?._id?.toString() || ''}`,
        },
      });

      LoggerUtil.info('mentorship:notify-join handled', { sessionId, joinerRole, targetUserId });
    } catch (err: any) {
      LoggerUtil.error('mentorship:notify-join failed', { error: err.message });
    }
  });

  // ✅ NEW: live-call emoji reactions (👍 ❤️ 😂 👏 🎉) — relayed 1:1 via
  // emitToUser, same mentor/mentee resolution as notify-join above. No new
  // socket room needed — reuses the existing user:{userId} room convention,
  // so it works even without touching liveRoomHandler.ts.
  socket.on('mentorship:send-reaction', async (data: { sessionId: string; emoji: string }) => {
    try {
      const { sessionId, emoji } = data;
      if (!sessionId || !emoji) return;

      // Fixed allow-list — don't let the client send arbitrary strings.
      const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '👏', '🎉'];
      if (!ALLOWED_REACTIONS.includes(emoji)) return;

      const session = await SessionMentor.findOne({ sessionId });
      if (!session) return;

      const mentor = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false });
      const mentorUserId = mentor?.userId;

      const confirmedBooking = session.bookings?.find((b: any) =>
        ['confirmed', 'in_progress', 'rescheduled'].includes(b.status)
      );
      const menteeUserId = session.menteeId || confirmedBooking?.menteeId || confirmedBooking?.bookedBy;

      const targetUserId = userId === mentorUserId ? menteeUserId : mentorUserId;
      if (!targetUserId) return;

      emitToUser(targetUserId, 'mentorship:reaction-received', {
        sessionId,
        emoji,
        fromUserId: userId,
      });
    } catch (err: any) {
      LoggerUtil.error('mentorship:send-reaction failed', { error: err.message });
    }
  });
};