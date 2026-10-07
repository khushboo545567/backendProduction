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
 *  5. ✅ NEW: group-session (mentorship) membership check — previously
 *     `isMember` only recognised StudyGroup rooms and 1:1 mentorship
 *     booking rooms. A group-session roomId (== GroupSession.sessionId)
 *     matched neither, so even an ACCEPTED participant was always
 *     rejected with "You are not a member of this group". Mirrors the
 *     same in_progress + role check `isMentorshipSessionMember` already
 *     does for 1:1 sessions.
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
import { SessionMentor, Mentor, GroupSession } from '@/Mentorship/models';

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_ROOM_SIZE = 16; // WebRTC mesh: 16 peers = 120 connections — hard limit

// ─── Global State for Study Sessions ──────────────────────────────────────────
export interface RoomSession {
  active: boolean;
  startedAt: number | null;
  accumulatedTime: number; // in milliseconds
}
const roomSessions = new Map<string, RoomSession>();

// ─── Helper: verify mentor/mentee membership on a mentorship session room ─────
async function isMentorshipSessionMember(userId: string, roomId: string): Promise<boolean> {
  try {
    const session = await SessionMentor.findOne({ 'bookings._id': roomId }).lean();
    if (!session) return false;

    const booking = (session.bookings || []).find((b: any) => b._id.toString() === roomId);
    if (!booking) return false;

     // Only allow while the specific booking is actually in progress —
    // blocks joining a room for a session that hasn't started or already ended.
    if ((booking.status as string) !== 'in_progress') return false;

    const menteeId = booking.menteeId || booking.bookedBy;
    if (menteeId && userId === menteeId.toString()) return true;

    const mentor = await Mentor.findOne({ mentorId: session.mentorId, isDeleted: false }).lean();
    return !!mentor && mentor.userId.toString() === userId;
  } catch (error: any) {
    LoggerUtil.warn(`isMentorshipSessionMember check failed: ${error.message}`);
    return false;
  }
}

// ─── Helper: verify room access and determine max capacity ────────────────────
async function getRoomAccess(userId: string, roomId: string): Promise<{ allowed: boolean, maxCapacity: number, errorReason?: string }> {
  // Allow mock group ID '1' for frontend UI testing
  if (roomId === '1' || roomId === 1 as any) return { allowed: true, maxCapacity: MAX_ROOM_SIZE };

  if (!userId || !roomId) {
    LoggerUtil.warn(`Missing userId or roomId in getRoomAccess check`);
    return { allowed: false, maxCapacity: 0, errorReason: 'Missing user ID or room ID' };
  }

  // 1. StudyGroup room
  try {
    let targetGroupId = roomId;
    if (mongoose.isValidObjectId(roomId)) {
      const liveRoom = await LiveRoom.findById(roomId).lean();
      if (!liveRoom) {
        return { allowed: false, maxCapacity: 0, errorReason: 'Live room not found' };
      }
      if (!liveRoom.isActive) {
        return { allowed: false, maxCapacity: 0, errorReason: 'This live room has ended' };
      }
      targetGroupId = liveRoom.group;
    }

    const member = await GroupMember.findOne({
      userId: userId,
      groupId: targetGroupId,
      status: 'active',
    }).lean();
    if (member) return { allowed: true, maxCapacity: MAX_ROOM_SIZE };
  } catch (error: any) {
    LoggerUtil.warn(`StudyGroup check failed: ${error.message}`);
  }

  // 2. Mentorship 1:1 room (bookingId is used as roomId)
  try {
    const mentorship1on1 = await isMentorshipSessionMember(userId, roomId);
    if (mentorship1on1) return { allowed: true, maxCapacity: 2 };
  } catch (error: any) {
    LoggerUtil.warn(`1:1 Mentorship check failed: ${error.message}`);
  }

  // 3. Mentorship Group Session room (GroupSession.sessionId is used as roomId)
  try {
    const session = await GroupSession.findOne({ sessionId: roomId }).lean();
    if (session) {
      if ((session as any).status !== 'in_progress') return { allowed: false, maxCapacity: 0 };

      let isAllowed = false;
      const participant = ((session as any).participants || []).find(
        (p: any) => p.menteeId.toString() === userId && p.requestStatus === 'accepted'
      );
      if (participant) {
        isAllowed = true;
      } else {
        const mentor = await Mentor.findOne({ mentorId: (session as any).mentorId, isDeleted: false }).lean();
        if (mentor && mentor.userId.toString() === userId) {
          isAllowed = true;
        }
      }

      if (isAllowed) {
        // Capacity is max mentees + 1 mentor
        return { allowed: true, maxCapacity: session.maxParticipants + 1 };
      }
    }
  } catch (error: any) {
    LoggerUtil.warn(`Group Session check failed: ${error.message}`);
  }

  return { allowed: false, maxCapacity: 0 };
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

      // roomId can be live room ObjectId or groupId
      const { allowed, maxCapacity, errorReason } = await getRoomAccess(userId, roomId);
      if (!allowed) {
        socket.emit('error', {
          event: 'join-live-room',
          message: errorReason || 'You are not a member of this group',
        });
        return;
      }

      // Enforce room size limit
      const currentSockets = await io.in(`live-room:${roomId}`).fetchSockets();
      if (currentSockets.length >= maxCapacity) {
        socket.emit('error', {
          event: 'join-live-room',
          message: `Live room is full (max ${maxCapacity} participants)`,
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

  // ── Disconnect cleanup ─────────────────────────────────────────────────────
  // socket.io removes the socket from all rooms automatically on disconnect,
  // but it does NOT emit 'leave-live-room' for us — so without this, other
  // peers never learn this user actually left (stale UI/session state).
   // 'disconnecting' use karo, 'disconnect' nahi: disconnect tak socket.rooms khali ho jata hai,
  // isliye purana handler kabhi kuch emit nahi karta tha.
  socket.on('disconnecting', async () => {
    try {
      // await se pehle sync capture karo
      const rooms = Array.from(socket.rooms || []).filter((r) =>
        r.startsWith('live-room:')
      );
      for (const room of rooms) {
        const roomId = room.replace('live-room:', '');
        // Is waqt ye socket abhi room me hai, isliye filter karna zaroori hai
        const remaining = (await io.in(room).fetchSockets()).filter(
          (s) => s.id !== socket.id
        );

        if (remaining.length === 0) {
          roomSessions.delete(roomId);
          LoggerUtil.info(`Cleared study session for empty room ${roomId} (disconnect)`);
        }

        // Same user ka naya socket (rejoin) room me hai to "left" mat bhejo,
        // warna peers naya working connection tod denge.
        const stillPresent = remaining.some((s: any) => s.data?.userId === userId);
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

  const validateSignaling = async (senderId: string, targetId: string, roomId: string): Promise<boolean> => {
    // 1. sender is authorized for the provided roomId
    const { allowed } = await getRoomAccess(senderId, roomId);
    if (!allowed) {
      LoggerUtil.warn(`Signaling blocked: sender ${senderId} not allowed in room ${roomId}`);
      return false;
    }

    // 2. target user is an active participant of the SAME live room
    const targetSockets = await io.in(`live-room:${roomId}`).fetchSockets();
    const isTargetInRoom = targetSockets.some(
      (s: any) => s.data?.userId === targetId || (s as any).userId === targetId
    );
    if (!isTargetInRoom) {
       LoggerUtil.warn(`Signaling blocked: target ${targetId} not in room ${roomId}`);
       return false;
    }

    return true;
  };

  socket.on('webrtc-offer', async (data: WebRTCOfferPayload) => {
    const { targetUserId, roomId, offer } = data;
    if (!targetUserId || !offer || !roomId) return;

    if (!(await validateSignaling(userId, targetUserId, roomId))) return;

    LoggerUtil.debug(`WebRTC offer from ${userId} to ${targetUserId}`);

    // Send ONLY to the target user's personal room
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