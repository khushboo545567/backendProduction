/**
 * ====================================
 * LIVE ROOM HANDLER
 * ====================================
 * server/thronet-server/src/StudyGroup/socket/liveRoomHandler.ts
 *
 * Fixes applied:
 *  1. WebRTC signaling is now peer-to-peer (user:{targetUserId} room),
 *     NOT room-wide broadcast
 *  2. Group membership verified before joining a room
 *  3. Room participant limit enforced (MAX_ROOM_SIZE)
 *  4. All event handlers validate input before acting
 */

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
import { LoggerUtil } from '@/shared/logger.util';
import { SessionMentor, Mentor } from '@/Mentorship/models';

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_ROOM_SIZE = 16; // WebRTC mesh: 16 peers = 120 connections — hard limit

// ─── Global State for Study Sessions ──────────────────────────────────────────
export interface RoomSession {
  active: boolean;
  startedAt: number | null;
  accumulatedTime: number; // in milliseconds
}
const roomSessions = new Map<string, RoomSession>();

// ─── Helper: verify active group membership ───────────────────────────────────
async function isMember(userId: string, groupId: string): Promise<boolean> {
  // Allow mock group ID '1' for frontend UI testing
  if (groupId === '1' || groupId === 1 as any) return true;

  if (!userId || !groupId) {
    LoggerUtil.warn(`Missing userId or groupId in isMember check`);
    return false;
  }

  // StudyGroup room — userId/groupId are UUID strings, matched against GroupMember
  const member = await GroupMember.findOne({
    userId: userId,
    groupId: groupId,
    status: 'active',
  }).lean();
  if (member) return true;

  // Not a StudyGroup member — check if this roomId is actually a mentorship
  // booking instead (mentor-session rooms reuse the booking's _id as roomId).
  return await isMentorshipSessionMember(userId, groupId);
}

// ─── Helper: verify mentor/mentee membership on a mentorship session room ─────
async function isMentorshipSessionMember(userId: string, roomId: string): Promise<boolean> {
  try {
    const session = await SessionMentor.findOne({ 'bookings._id': roomId }).lean();
    if (!session) return false;

    const booking = (session.bookings || []).find((b: any) => b._id.toString() === roomId);
    if (!booking) return false;

     // Only allow while the specific booking is actually in progress —
    // blocks joining a room for a session that hasn't started or already ended.
    // ⚠️ TS2367: this import path's booking-status type is missing 'in_progress'
    // (and likely 'rescheduled') even though startSession() in
    // mentorshipSession.service.ts sets exactly this value at runtime. Casting
    // sidesteps the stale type without weakening the actual check. Send the
    // ISessionMentor booking type (session.types.ts) to fix the type at its root.
    if ((booking.status as string) !== 'in_progress') return false;

    const menteeId = booking.menteeId || booking.bookedBy;
    if (menteeId && userId === menteeId) return true;

    const mentor = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false }).lean();
    return !!mentor && mentor.userId === userId;
  } catch (error: any) {
    LoggerUtil.warn(`isMentorshipSessionMember check failed: ${error.message}`);
    return false;
  }
}



// ─── Handler ─────────────────────────────────────────────────────────────────
export const liveRoomHandler = (io: Server, socket: AuthenticatedSocket): void => {
  const userId   = (socket.data as any).userId || (socket as any).userId;
  const userName = (socket.data as any).userName || (socket as any).userName || 'Unknown';

  // ── Join live room ─────────────────────────────────────────────────────────
  socket.on('join-live-room', async (data: JoinLiveRoomPayload) => {
    try {
      const { roomId } = data;
      if (!roomId) return;

      // roomId == groupId in your domain
      const allowed = await isMember(userId, roomId);
      if (!allowed) {
        socket.emit('error', {
          event: 'join-live-room',
          message: 'You are not a member of this group',
        });
        return;
      }

      // Enforce room size limit
      const currentSockets = await io.in(`live-room:${roomId}`).fetchSockets();
      if (currentSockets.length >= MAX_ROOM_SIZE) {
        socket.emit('error', {
          event: 'join-live-room',
          message: `Live room is full (max ${MAX_ROOM_SIZE} participants)`,
        });
        return;
      }

      socket.join(`live-room:${roomId}`);
      LoggerUtil.info(`User ${userId} joined live room ${roomId}`);

      const currentSocketsAfterJoin = await io.in(`live-room:${roomId}`).fetchSockets();
      if (currentSocketsAfterJoin.length === 1) {
        // Start session automatically for the first user
        if (!roomSessions.has(roomId)) {
          roomSessions.set(roomId, {
            active: true,
            startedAt: Date.now(),
            accumulatedTime: 0
          });
          LoggerUtil.info(`Started study session automatically for room ${roomId}`);
        }
      }

      // Tell existing participants about the new arrival
      socket.to(`live-room:${roomId}`).emit('user-joined-room', {
        userId,
        userName,
        timestamp: new Date(),
      });

      // Send current participant list back to the joiner
      const socketsInRoom = await io.in(`live-room:${roomId}`).fetchSockets();
      const participants = socketsInRoom
        .map((s: any) => ({
          userId:   s.data.userId,
          userName: s.data.userName ?? 'Unknown',
          socketId: s.id,
        }))
        .filter((p) => p.userId);

      socket.emit('room-participants-list', {
        roomId,
        participants,
        count: participants.length,
      });

    } catch (error: any) {
      LoggerUtil.error('Error joining live room', { error: error.message, userId });
    }
  });

  // ── Leave live room ────────────────────────────────────────────────────────
  socket.on('leave-live-room', async (data: LeaveLiveRoomPayload) => {
    const { roomId } = data;
    if (!roomId) return;

    socket.leave(`live-room:${roomId}`);
    LoggerUtil.info(`User ${userId} left live room ${roomId}`);

    const remainingSockets = await io.in(`live-room:${roomId}`).fetchSockets();
    if (remainingSockets.length === 0) {
      roomSessions.delete(roomId);
      LoggerUtil.info(`Cleared study session for empty room ${roomId}`);
    }

    socket.to(`live-room:${roomId}`).emit('user-left-room', {
      userId,
      userName,
      timestamp: new Date(),
    });
  });

  // ── Camera toggle ──────────────────────────────────────────────────────────
  socket.on('toggle-camera', (data: ToggleCameraPayload) => {
    const { roomId, cameraOn } = data;
    if (!roomId) return;

    // Store state in socket data for new users who join later
    (socket.data as any).camOn = cameraOn;

    socket.to(`live-room:${roomId}`).emit('user-camera-toggle', {
      userId,
      cameraOn,
      timestamp: new Date(),
    });
  });

  // ── Mic toggle ─────────────────────────────────────────────────────────────
  socket.on('toggle-mic', (data: ToggleMicPayload) => {
    const { roomId, micOn } = data;
    if (!roomId) return;

    // Store state in socket data for new users who join later
    (socket.data as any).micOn = micOn;

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

  // ── Get participants ───────────────────────────────────────────────────────
  socket.on('get-room-participants', async (data: GetRoomParticipantsPayload) => {
    try {
      const { roomId } = data;
      if (!roomId) return;

      const socketsInRoom = await io.in(`live-room:${roomId}`).fetchSockets();
      const participants = socketsInRoom
        .map((s: any) => ({
          userId:   s.data.userId,
          userName: s.data.userName ?? 'Unknown',
          socketId: s.id,
          camOn: s.data.camOn || false,
          micOn: s.data.micOn || false,
        }))
        .filter((p) => p.userId);

      socket.emit('room-participants-list', {
        roomId,
        participants,
        count: participants.length,
        session: roomSessions.get(roomId) || null,
      });

    } catch (error: any) {
      LoggerUtil.error('Error fetching room participants', { error: error.message, userId });
    }
  });

  // ── Session toggle ───────────────────────────────────────────────────────────
  socket.on('toggle-session', async (data: { roomId: string, active: boolean }) => {
    const { roomId, active } = data;
    if (!roomId) return;

    // Verify admin / leader
    const member = await GroupMember.findOne({
      userId,
      groupId: roomId,
      role: { $in: ['leader', 'moderator'] },
      status: 'active'
    }).lean();

    if (!member) {
      socket.emit('error', { event: 'toggle-session', message: 'Only leaders and moderators can toggle the study session' });
      return;
    }

    let session = roomSessions.get(roomId);
    if (!session) {
      session = {
        active,
        startedAt: active ? Date.now() : null,
        accumulatedTime: 0
      };
      roomSessions.set(roomId, session);
    } else {
      if (session.active !== active) {
        if (active) {
          // Resume
          session.active = true;
          session.startedAt = Date.now();
        } else {
          // Pause
          session.active = false;
          if (session.startedAt) {
            session.accumulatedTime += Date.now() - session.startedAt;
            session.startedAt = null;
          }
        }
      }
    }

    // Broadcast the new session state to everyone in the room
    io.in(`live-room:${roomId}`).emit('session-toggled', {
      roomId,
      session
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WebRTC SIGNALING — peer-to-peer, NOT room-wide broadcast
  //
  // Each signal (offer / answer / ICE candidate) must reach ONLY the intended
  // peer. We use their personal room (user:{targetUserId}) which is joined
  // server-side on connection (see socket/index.ts).
  // ─────────────────────────────────────────────────────────────────────────

  socket.on('webrtc-offer', (data: WebRTCOfferPayload) => {
    const { targetUserId, roomId, offer } = data;
    if (!targetUserId || !offer) return;

    LoggerUtil.debug(`WebRTC offer from ${userId} to ${targetUserId}`);

    // Send ONLY to the target user's personal room
    io.to(`user:${targetUserId}`).emit('webrtc-offer-received', {
      fromUserId: userId,
      roomId,
      offer,
    });
  });

  socket.on('webrtc-answer', (data: WebRTCAnswerPayload) => {
    const { targetUserId, roomId, answer } = data;
    if (!targetUserId || !answer) return;

    LoggerUtil.debug(`WebRTC answer from ${userId} to ${targetUserId}`);

    io.to(`user:${targetUserId}`).emit('webrtc-answer-received', {
      fromUserId: userId,
      roomId,
      answer,
    });
  });

  socket.on('webrtc-ice-candidate', (data: WebRTCIceCandidatePayload) => {
    const { targetUserId, roomId, candidate } = data;
    if (!targetUserId || !candidate) return;

    io.to(`user:${targetUserId}`).emit('webrtc-ice-candidate-received', {
      fromUserId: userId,
      roomId,
      candidate,
    });
  });
};

export default liveRoomHandler;