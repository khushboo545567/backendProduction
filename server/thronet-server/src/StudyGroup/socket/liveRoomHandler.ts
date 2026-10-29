/**
 * ====================================
 * LIVE ROOM HANDLER
 * ====================================
 * server/thronet-server/src/StudyGroup/socket/liveRoomHandler.ts
 *
 * Item L: Redis-backed Live Room participant sets and study session timer state.
 *  1. WebRTC signaling is peer-to-peer (user:{targetUserId} room), NOT room-wide broadcast,
 *     and does NOT touch Redis storage.
 *  2. Group membership verified before joining a room.
 *  3. Room participant limit enforced atomically in Redis (MAX_ROOM_SIZE).
 *  4. Study session timer state persisted in Redis across multi-instance nodes and restarts.
 */

import mongoose from 'mongoose';
import { Server } from 'socket.io';
import {
  AuthenticatedSocket,
  JoinLiveRoomPayload,
  LeaveLiveRoomPayload,
  ToggleCameraPayload,
  ToggleMicPayload,
  ToggleScreenSharePayload,
  GetRoomParticipantsPayload,
  WebRTCOfferPayload,
  WebRTCAnswerPayload,
  WebRTCIceCandidatePayload,
} from '../types/Socket.types';
import GroupMember from '../models/GroupMember.model';
import LiveRoom from '../models/LiveRoom.model';
import { LoggerUtil } from '@/shared/logger.util';
import { SessionMentor, Mentor, GroupSession, SeniorSession } from '@/Mentorship/models';
import { SocketLiveRoomRepository, RoomSessionState } from '@/shared/cache/socketCache';
import type { Types } from 'mongoose';

type BookingWithExtras = {
  _id?: Types.ObjectId | string;
  slotDuration?: number;
  duration?: number;
  scheduledAt?: Date;
  status?: string;
};
// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_ROOM_SIZE = 16; // WebRTC mesh: 16 peers = 120 connections - hard limit

const NOT_STARTED_REASON = 'Session has not been started yet (or it has already ended)';

// Re-export RoomSession for backward compatibility
export type RoomSession = RoomSessionState;

interface MembershipResult {
  ok: boolean;
  reason?: string;
  canonicalRoomId?: string;
}

// ─── Helper: verify mentor/mentee membership on a mentorship session room ─────
// roomId can be booking._id, booking.bookingId, session.sessionId, or session._id
export async function isMentorshipSessionMember(userId: string, roomId: string): Promise<MembershipResult> {
  try {
    const orConditions: any[] = [
      { sessionId: roomId },
      { 'bookings.bookingId': roomId },
    ];
    if (mongoose.isValidObjectId(roomId)) {
      orConditions.push({ _id: roomId });
      orConditions.push({ 'bookings._id': roomId });
    }

    const session = await SessionMentor.findOne({ $or: orConditions }).lean();
    if (!session) return { ok: false };

    // Identify target booking if applicable
    let booking: any = (session.bookings || []).find(
      (b: any) =>
        b._id?.toString() === roomId ||
        b.bookingId === roomId
    );

    // If roomId was sessionId or session._id, find matching booking for this user
    if (!booking) {
      booking = (session.bookings || []).find(
        (b: any) =>
          b.menteeId?.toString() === userId ||
          b.bookedBy?.toString() === userId
      );
      if (!booking) {
        // If user is mentor, pick active in_progress, confirmed, or first booking
        booking =
          (session.bookings || []).find((b: any) => b.status === 'in_progress') ||
          (session.bookings || []).find((b: any) => b.status === 'confirmed' || b.status === 'rescheduled') ||
          (session.bookings || [])[0];
      }
    }

    // Verify authorized participant: mentor or mentee
    const mentor = await Mentor.findOne({
      $or: [
        { mentorId: session.mentorId },
        ...(mongoose.isValidObjectId(session.mentorId) ? [{ _id: session.mentorId }] : []),
      ],
      isDeleted: false,
    }).lean();

    const isMentor =
      (mentor && (
        mentor.userId?.toString() === userId ||
        mentor.mentorId?.toString() === userId ||
        mentor._id?.toString() === userId
      )) ||
      session.mentorId?.toString() === userId;

    const isMentee =
      (booking && (booking.menteeId?.toString() === userId || booking.bookedBy?.toString() === userId)) ||
      session.menteeId?.toString() === userId ||
      (session.bookings || []).some(
        (b: any) => b.menteeId?.toString() === userId || b.bookedBy?.toString() === userId
      );

    if (!isMentor && !isMentee) {
      return { ok: false, reason: 'You are not an authorized participant of this session' };
    }

    // Terminal status check: completed, cancelled, refunded
    const bookingStatus = (booking?.status || session.status || '').toLowerCase();
    if (
      ['completed', 'cancelled', 'refunded', 'no_show'].includes(bookingStatus) ||
      session.status === 'completed' ||
      session.status === 'cancelled'
    ) {
      return { ok: false, reason: 'This session has ended or was cancelled' };
    }

    // Canonical room ID: booking._id if present, fallback to session.sessionId
    const canonicalRoomId = booking?._id?.toString() || session.sessionId;

    // Time window check:
    const scheduledStart = new Date(booking?.scheduledAt || session.scheduledAt || 0).getTime();
    const durationMin = Number(booking?.slotDuration || booking?.duration || session.duration || 60);
    const bufferMinutes = 60; // 60 min grace window after scheduled end for reconnects/overtime
    const earlyMinutes = 15;  // 15 min before start time
    const now = Date.now();

    // If session is already in_progress, allow join/rejoin as long as not explicitly ended
    if (session.status === 'in_progress' || bookingStatus === 'in_progress') {
      const startMs = session.startedAt ? new Date(session.startedAt).getTime() : scheduledStart;
      const hardEndMs = startMs + (durationMin + bufferMinutes) * 60 * 1000;
      if (now > hardEndMs && session.endedAt) {
        return { ok: false, reason: 'This session has ended' };
      }
      return { ok: true, canonicalRoomId };
    }

    // If confirmed / scheduled:
    if (scheduledStart > 0) {
      if (now < scheduledStart - earlyMinutes * 60 * 1000) {
        return { ok: false, reason: 'Session cannot be joined yet — too early' };
      }
      const endMs = scheduledStart + (durationMin + bufferMinutes) * 60 * 1000;
      if (now > endMs) {
        return { ok: false, reason: 'Session start window has expired' };
      }
    }

    return { ok: true, canonicalRoomId };
  } catch (error: any) {
    LoggerUtil.warn(`isMentorshipSessionMember check failed: ${error.message}`);
    return { ok: false, reason: 'Failed to verify session membership' };
  }
}

// ─── Helper: verify mentor/mentee membership on a Senior Mentor 1:1 session room ─────
async function isSeniorOneToOneSessionMember(userId: string, roomId: string): Promise<MembershipResult> {
  try {
    const orConditions: any[] = [
      { sessionId: roomId },
      { 'bookings.bookingId': roomId },
    ];
    if (mongoose.isValidObjectId(roomId)) {
      orConditions.push({ _id: roomId });
      orConditions.push({ 'bookings._id': roomId });
    }

    const session = (await SeniorSession.findOne({ $or: orConditions }).lean()) as any;
    if (!session) return { ok: false };

    // Strictly one-to-one sessions only
    const sessionTypeStr = session.sessionType as string | undefined;
    if (sessionTypeStr && sessionTypeStr !== 'one_to_one' && sessionTypeStr !== '1_on_1') {
      return { ok: false };
    }

    let booking = (session.bookings || []).find(
      (b: any) =>
        b._id?.toString() === roomId ||
        b.bookingId === roomId
    );

    if (!booking) {
      booking = (session.bookings || []).find(
        (b: any) =>
          (b.menteeId || b.bookedBy)?.toString() === userId
      );
      if (!booking) {
        booking =
          (session.bookings || []).find((b: any) => b.status === 'in_progress') ||
          (session.bookings || []).find((b: any) => b.status === 'confirmed' || b.status === 'upcoming') ||
          (session.bookings || [])[0];
      }
    }

    let isMember = false;
    const menteeId = (booking?.menteeId || booking?.bookedBy)?.toString();
    if (menteeId && userId === menteeId) {
      isMember = true;
    } else if (session.mentorId && session.mentorId.toString() === userId) {
      isMember = true;
    } else {
      const mentor = await Mentor.findOne({
        $or: [
          { mentorId: session.mentorId },
          ...(mongoose.isValidObjectId(session.mentorId) ? [{ _id: session.mentorId }] : []),
        ],
        isDeleted: false,
      }).lean();
      isMember = !!mentor && (
        mentor.userId?.toString() === userId ||
        mentor.mentorId?.toString() === userId ||
        mentor._id?.toString() === userId
      );
    }
    if (!isMember) {
      return { ok: false, reason: 'You are not an authorized participant of this session' };
    }

    const bookingStatus = (booking?.status || session.status || '').toLowerCase();
    if (
      ['completed', 'cancelled', 'refunded', 'no_show'].includes(bookingStatus) ||
      session.status === 'cancelled' ||
      session.status === 'completed'
    ) {
      return { ok: false, reason: 'This session has ended or was cancelled' };
    }

    const canonicalRoomId = booking?._id?.toString() || session.sessionId;
    const scheduledStart = new Date(booking?.scheduledAt || session.scheduledAt || 0).getTime();
    const durationMin = Number(booking?.duration || session.duration || 60);
    const bufferMinutes = 60;
    const earlyMinutes = 15;
    const now = Date.now();

    if (session.status === 'in_progress' || bookingStatus === 'in_progress') {
      const startMs = session.startedAt ? new Date(session.startedAt).getTime() : scheduledStart;
      const hardEndMs = startMs + (durationMin + bufferMinutes) * 60 * 1000;
      if (now > hardEndMs && session.endedAt) {
        return { ok: false, reason: 'This session has ended' };
      }
      return { ok: true, canonicalRoomId };
    }

    if (scheduledStart > 0) {
      if (now < scheduledStart - earlyMinutes * 60 * 1000) {
        return { ok: false, reason: 'Session cannot be joined yet — too early' };
      }
      const endMs = scheduledStart + (durationMin + bufferMinutes) * 60 * 1000;
      if (now > endMs) {
        return { ok: false, reason: 'Session start window has expired' };
      }
    }

    return { ok: true, canonicalRoomId };
  } catch (error: any) {
    LoggerUtil.warn(`isSeniorOneToOneSessionMember check failed: ${error.message}`);
    return { ok: false, reason: 'Failed to verify session membership' };
  }
}

// ─── Helper: verify room access and determine max capacity ────────────────────
export async function getRoomAccess(
  userId: string,
  roomId: string
): Promise<{ allowed: boolean; maxCapacity: number; errorReason?: string; canonicalRoomId?: string }> {
  // Allow mock group ID '1' for frontend UI testing
  if (roomId === '1' || (roomId as any) === 1) return { allowed: true, maxCapacity: MAX_ROOM_SIZE };

  if (!userId || !roomId) {
    LoggerUtil.warn(`Missing userId or roomId in getRoomAccess check`);
    return { allowed: false, maxCapacity: 0, errorReason: 'Missing user ID or room ID' };
  }

  // 1. Mentorship 1:1 room
  try {
    const mentorship1on1 = await isMentorshipSessionMember(userId, roomId);
    if (mentorship1on1.ok) {
      return { allowed: true, maxCapacity: 2, canonicalRoomId: mentorship1on1.canonicalRoomId };
    }
    if (mentorship1on1.reason) {
      return { allowed: false, maxCapacity: 0, errorReason: mentorship1on1.reason };
    }
  } catch (error: any) {
    LoggerUtil.warn(`1:1 Mentorship check failed: ${error.message}`);
  }

  // 2. Mentorship Group Session room
  try {
    const orConditions: any[] = [{ sessionId: roomId }];
    if (mongoose.isValidObjectId(roomId)) {
      orConditions.push({ _id: roomId });
    }
    const session = await GroupSession.findOne({ $or: orConditions }).lean();
    if (session) {
      const status = (session as any).status?.toLowerCase();
      if (status === 'completed' || status === 'cancelled') {
        return { allowed: false, maxCapacity: 0, errorReason: 'This session has ended or was cancelled' };
      }

      let isAllowed = false;
      const participant = ((session as any).participants || []).find(
        (p: any) => p.menteeId?.toString() === userId && p.requestStatus === 'accepted'
      );
      if (participant) {
        isAllowed = true;
      } else {
        const mentor = await Mentor.findOne({
          $or: [
            { mentorId: (session as any).mentorId },
            ...(mongoose.isValidObjectId((session as any).mentorId) ? [{ _id: (session as any).mentorId }] : []),
          ],
          isDeleted: false,
        }).lean();
        if (
          (mentor && (
            mentor.userId?.toString() === userId ||
            mentor.mentorId?.toString() === userId ||
            mentor._id?.toString() === userId
          )) ||
          (session as any).mentorId?.toString() === userId
        ) {
          isAllowed = true;
        }
      }

      if (!isAllowed) {
        return { allowed: false, maxCapacity: 0, errorReason: 'You are not an authorized participant of this group session' };
      }

      const scheduledStart = new Date((session as any).scheduledAt || 0).getTime();
      const durationMin = Number((session as any).duration || 60);
      const bufferMinutes = 60;
      const earlyMinutes = 15;
      const now = Date.now();

      if (status === 'in_progress') {
        return { allowed: true, maxCapacity: session.maxParticipants + 1, canonicalRoomId: session.sessionId };
      }

      if (scheduledStart > 0) {
        if (now < scheduledStart - earlyMinutes * 60 * 1000) {
          return { allowed: false, maxCapacity: 0, errorReason: 'Session cannot be joined yet — too early' };
        }
        if (now > scheduledStart + (durationMin + bufferMinutes) * 60 * 1000) {
          return { allowed: false, maxCapacity: 0, errorReason: 'Session window has expired' };
        }
      }

      return { allowed: true, maxCapacity: session.maxParticipants + 1, canonicalRoomId: session.sessionId };
    }
  } catch (error: any) {
    LoggerUtil.warn(`Group Session check failed: ${error.message}`);
  }

  // 3. Senior Mentor 1:1 room
  try {
    const senior1on1 = await isSeniorOneToOneSessionMember(userId, roomId);
    if (senior1on1.ok) {
      return { allowed: true, maxCapacity: 2, canonicalRoomId: senior1on1.canonicalRoomId };
    }
    if (senior1on1.reason) {
      return { allowed: false, maxCapacity: 0, errorReason: senior1on1.reason };
    }
  } catch (error: any) {
    LoggerUtil.warn(`Senior Mentor 1:1 check failed: ${error.message}`);
  }

  // 4. StudyGroup LiveRoom (only when room is a genuine study group room)
  try {
    let studyGroupId: any = null;

    if (mongoose.isValidObjectId(roomId)) {
      const liveRoom = await LiveRoom.findById(roomId).lean();
      if (liveRoom) {
        if (!liveRoom.isActive) {
          return { allowed: false, maxCapacity: 0, errorReason: 'This live room has ended' };
        }
        studyGroupId = liveRoom.group;
      }
    } else {
      const groupModel = mongoose.models['Group'];
      if (groupModel) {
        const groupExists = await groupModel.exists({ _id: roomId }).catch(() => null);
        if (groupExists) {
          studyGroupId = roomId;
        }
      }
    }

    if (studyGroupId) {
      const member = await GroupMember.findOne({
        userId: userId,
        groupId: studyGroupId,
        status: 'active',
      }).lean();
      if (member) return { allowed: true, maxCapacity: MAX_ROOM_SIZE };
      return { allowed: false, maxCapacity: 0, errorReason: 'You are not a member of this group' };
    }
  } catch (error: any) {
    LoggerUtil.warn(`StudyGroup check failed: ${error.message}`);
  }

  LoggerUtil.warn(`Room access denied: user ${userId} → room ${roomId}`);
  return {
    allowed: false,
    maxCapacity: 0,
    errorReason: 'You are not authorized to join this room',
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export const liveRoomHandler = (io: Server, socket: AuthenticatedSocket): void => {
  const userId = (socket.data as any).userId || (socket as any).userId;
  const userName = (socket.data as any).userName || (socket as any).userName || 'Unknown';

  // ── Join live room ─────────────────────────────────────────────────────────
  socket.on('join-live-room', async (data: JoinLiveRoomPayload) => {
    try {
      const { roomId } = data;
      if (!roomId) return;

      const { allowed, maxCapacity, errorReason, canonicalRoomId } = await getRoomAccess(userId, roomId);
      if (!allowed) {
        socket.emit('error', {
          event: 'join-live-room',
          message: errorReason || 'You are not authorized to join this room',
        });
        return;
      }

      const effectiveRoomId = canonicalRoomId || roomId;

      // Enforce room size limit and track participant in Redis
      const joinResult = await SocketLiveRoomRepository.addParticipant(
        effectiveRoomId,
        userId,
        socket.id,
        { userName },
        maxCapacity
      );

      if (!joinResult.success) {
        socket.emit('error', {
          event: 'join-live-room',
          message: joinResult.errorReason || `Live room is full (max ${maxCapacity} participants)`,
        });
        return;
      }

      socket.join(`live-room:${effectiveRoomId}`);
      if (effectiveRoomId !== roomId) {
        socket.join(`live-room:${roomId}`);
      }
      LoggerUtil.info(`User ${userId} joined live room ${effectiveRoomId} (via ${roomId})`);

      // Start study session automatically for the first user
      let session = await SocketLiveRoomRepository.getRoomSession(effectiveRoomId);
      if (joinResult.isFirst) {
        if (!session) {
          session = await SocketLiveRoomRepository.startRoomSession(effectiveRoomId);
          LoggerUtil.info(`Started study session automatically for room ${effectiveRoomId}`);
        }
      }

      // Tell existing participants about the arrival (or rejoin)
      const joinBroadcast = {
        userId,
        userName,
        timestamp: new Date(),
        isRejoin: !joinResult.isFirst,
      };
      socket.to(`live-room:${effectiveRoomId}`).emit('user-joined-room', joinBroadcast);
      if (effectiveRoomId !== roomId) {
        socket.to(`live-room:${roomId}`).emit('user-joined-room', joinBroadcast);
      }

      // Send current participant list back to the joiner from Redis
      const participants = await SocketLiveRoomRepository.getRoomParticipants(effectiveRoomId);

      socket.emit('room-participants-list', {
        roomId,
        canonicalRoomId: effectiveRoomId,
        participants,
        count: participants.length,
        session: session || null,
      });

      if (effectiveRoomId !== roomId) {
        socket.emit('room-participants-list', {
          roomId: effectiveRoomId,
          canonicalRoomId: effectiveRoomId,
          participants,
          count: participants.length,
          session: session || null,
        });
      }
    } catch (error: any) {
      LoggerUtil.error('Error joining live room', { error: error.message, userId });
      socket.emit('error', {
        event: 'join-live-room',
        message: 'Could not join the room. Please try again.',
      });
    }
  });

  // ── Leave live room ────────────────────────────────────────────────────────
  socket.on('leave-live-room', async (data: LeaveLiveRoomPayload) => {
    const { roomId } = data;
    if (!roomId) return;

    const access = await getRoomAccess(userId, roomId);
    const effectiveRoomId = access.canonicalRoomId || roomId;

    socket.leave(`live-room:${effectiveRoomId}`);
    if (effectiveRoomId !== roomId) {
      socket.leave(`live-room:${roomId}`);
    }
    LoggerUtil.info(`User ${userId} left live room ${effectiveRoomId}`);

    const { isRoomEmpty } = await SocketLiveRoomRepository.removeParticipant(effectiveRoomId, socket.id);
    if (isRoomEmpty) {
      LoggerUtil.info(`Cleared study session for empty room ${effectiveRoomId}`);
    }

    const leavePayload = {
      userId,
      userName,
      timestamp: new Date(),
    };
    socket.to(`live-room:${effectiveRoomId}`).emit('user-left-room', leavePayload);
    if (effectiveRoomId !== roomId) {
      socket.to(`live-room:${roomId}`).emit('user-left-room', leavePayload);
    }
  });

  // ── Heartbeat for live room presence ──────────────────────────────────────
  socket.on('liveroom:heartbeat', async (data: { roomId: string }) => {
    if (data?.roomId) {
      await SocketLiveRoomRepository.heartbeat(data.roomId, socket.id);
    }
  });

  // ── Camera toggle ──────────────────────────────────────────────────────────
  socket.on('toggle-camera', async (data: ToggleCameraPayload) => {
    const { roomId, cameraOn } = data;
    if (!roomId) return;

    (socket.data as any).camOn = cameraOn;
    await SocketLiveRoomRepository.updateParticipantState(roomId, socket.id, { camOn: cameraOn });

    socket.to(`live-room:${roomId}`).emit('user-camera-toggle', {
      userId,
      cameraOn,
      timestamp: new Date(),
    });
  });

  // ── Mic toggle ─────────────────────────────────────────────────────────────
  socket.on('toggle-mic', async (data: ToggleMicPayload) => {
    const { roomId, micOn } = data;
    if (!roomId) return;

    (socket.data as any).micOn = micOn;
    await SocketLiveRoomRepository.updateParticipantState(roomId, socket.id, { micOn });

    socket.to(`live-room:${roomId}`).emit('user-mic-toggle', {
      userId,
      micOn,
      timestamp: new Date(),
    });
  });

  // ── Screen share ───────────────────────────────────────────────────────────
  socket.on('toggle-screen-share', (data: ToggleScreenSharePayload) => {
    const { roomId, sharing } = data;
    if (!roomId) return;

    socket.to(`live-room:${roomId}`).emit('user-screen-share-toggle', {
      userId,
      sharing,
      timestamp: new Date(),
    });
  });

  // ── Disconnect cleanup ─────────────────────────────────────────────────────
  socket.on('disconnecting', async () => {
    try {
      const rooms = Array.from(socket.rooms || []).filter((r) => r.startsWith('live-room:'));
      for (const room of rooms) {
        const roomId = room.replace('live-room:', '');
        const { isRoomEmpty } = await SocketLiveRoomRepository.removeParticipant(roomId, socket.id);

        if (isRoomEmpty) {
          LoggerUtil.info(`Cleared study session for empty room ${roomId} (disconnect)`);
        }

        // Check if user still has another socket in the room
        const remainingParticipants = await SocketLiveRoomRepository.getRoomParticipants(roomId);
        const stillPresent = remainingParticipants.some((p) => p.userId === userId);
        if (stillPresent) continue;

        socket.to(room).emit('user-left-room', {
          userId,
          userName,
          timestamp: new Date(),
        });
      }
    } catch (error: any) {
      LoggerUtil.error('Error handling disconnect cleanup', { error: error.message, userId });
    }
  });

  // ── Get participants ───────────────────────────────────────────────────────
  socket.on('get-room-participants', async (data: GetRoomParticipantsPayload) => {
    try {
      const { roomId } = data;
      if (!roomId) return;

      const participants = await SocketLiveRoomRepository.getRoomParticipants(roomId);
      const session = await SocketLiveRoomRepository.getRoomSession(roomId);

      socket.emit('room-participants-list', {
        roomId,
        participants,
        count: participants.length,
        session: session || null,
      });
    } catch (error: any) {
      LoggerUtil.error('Error fetching room participants', { error: error.message, userId });
    }
  });

  // ── Session toggle ───────────────────────────────────────────────────────────
  socket.on('toggle-session', async (data: { roomId: string; active: boolean }) => {
    const { roomId, active } = data;
    if (!roomId) return;

    // Verify admin / leader
    const member = await GroupMember.findOne({
      userId,
      groupId: roomId,
      role: { $in: ['leader', 'moderator'] },
      status: 'active',
    }).lean();

    if (!member) {
      socket.emit('error', {
        event: 'toggle-session',
        message: 'Only leaders and moderators can toggle the study session',
      });
      return;
    }

    const session = await SocketLiveRoomRepository.toggleRoomSession(roomId, active);

    // Broadcast the new session state to everyone in the room
    io.in(`live-room:${roomId}`).emit('session-toggled', {
      roomId,
      session,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WebRTC SIGNALING - peer-to-peer, NOT room-wide broadcast
  // WebRTC signaling does NOT touch Redis storage. It is routed peer-to-peer
  // via Socket.IO events to user:{targetUserId}.
  // ─────────────────────────────────────────────────────────────────────────

  const validateSignaling = async (senderId: string, targetId: string, roomId: string): Promise<boolean> => {
    const { allowed, canonicalRoomId } = await getRoomAccess(senderId, roomId);
    if (!allowed) {
      LoggerUtil.warn(`Signaling blocked: sender ${senderId} not allowed in room ${roomId}`);
      return false;
    }

    const effectiveRoomId = canonicalRoomId || roomId;
    const participants = await SocketLiveRoomRepository.getRoomParticipants(effectiveRoomId);
    let isTargetInRoom = participants.some((p) => p.userId === targetId);
    if (!isTargetInRoom && effectiveRoomId !== roomId) {
      const origParticipants = await SocketLiveRoomRepository.getRoomParticipants(roomId);
      isTargetInRoom = origParticipants.some((p) => p.userId === targetId);
    }

    if (!isTargetInRoom) {
      // Fallback check in local room sockets
      const targetSockets = await io.in(`live-room:${effectiveRoomId}`).fetchSockets();
      let isTargetInLocal = targetSockets.some(
        (s: any) => s.data?.userId === targetId || (s as any).userId === targetId
      );
      if (!isTargetInLocal && effectiveRoomId !== roomId) {
        const origSockets = await io.in(`live-room:${roomId}`).fetchSockets();
        isTargetInLocal = origSockets.some(
          (s: any) => s.data?.userId === targetId || (s as any).userId === targetId
        );
      }
      if (!isTargetInLocal) {
        LoggerUtil.warn(`Signaling blocked: target ${targetId} not in room ${effectiveRoomId}`);
        return false;
      }
    }

    return true;
  };

  socket.on('webrtc-offer', async (data: WebRTCOfferPayload) => {
    const { targetUserId, roomId, offer } = data;
    if (!targetUserId || !offer || !roomId) return;

    if (!(await validateSignaling(userId, targetUserId, roomId))) return;

    LoggerUtil.debug(`WebRTC offer from ${userId} to ${targetUserId}`);

    io.to(`user:${targetUserId}`).emit('webrtc-offer-received', {
      fromUserId: userId,
      roomId,
      offer,
    });
  });

  socket.on('webrtc-answer', async (data: WebRTCAnswerPayload) => {
    const { targetUserId, roomId, answer } = data;
    if (!targetUserId || !answer || !roomId) return;

    if (!(await validateSignaling(userId, targetUserId, roomId))) return;

    LoggerUtil.debug(`WebRTC answer from ${userId} to ${targetUserId}`);

    io.to(`user:${targetUserId}`).emit('webrtc-answer-received', {
      fromUserId: userId,
      roomId,
      answer,
    });
  });

  socket.on('webrtc-ice-candidate', async (data: WebRTCIceCandidatePayload) => {
    const { targetUserId, roomId, candidate } = data;
    if (!targetUserId || !candidate || !roomId) return;

    if (!(await validateSignaling(userId, targetUserId, roomId))) return;

    io.to(`user:${targetUserId}`).emit('webrtc-ice-candidate-received', {
      fromUserId: userId,
      roomId,
      candidate,
    });
  });
};

export default liveRoomHandler;
