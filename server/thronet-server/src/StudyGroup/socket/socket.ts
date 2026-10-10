/**
 * ====================================
 * SOCKET.IO MAIN HANDLER
 * ====================================
 * Main socket.io event handler and connection manager
 */

import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { LoggerUtil } from '@/shared/logger.util';
import { User } from '@/auth/models';
import GroupMember from '../models/GroupMember.model';
import { handleChatEvents } from './chatHandler';
import { handleTypingEvents } from './typingHandler';
import { handlePresenceEvents } from './presenceHandler';
import { liveRoomHandler } from './liveRoomHandler';
import { UserRole } from '../enums';

export interface JWTPayload {
  userId: string;
  email: string;
  role: UserRole;
}

// Store active socket connections
const userSockets = new Map<string, Set<string>>(); // userId -> Set of socketIds
const socketUsers = new Map<string, string>(); // socketId -> userId
const groupRooms = new Map<string, Set<string>>(); // groupId -> Set of userIds
// Active session tracking per group room
const groupActiveSessions = new Map<string, Map<string, { lastSeen: number; elapsedTime: number }>>(); // groupId -> Map of userId -> session
const socketBroadcastRateLimit = new Map<string, number>(); // socketId -> timestamp

const removeUserActiveSession = (groupId: string, userId: string, io: Server) => {
  const sessions = groupActiveSessions.get(groupId);
  if (sessions && sessions.has(userId)) {
    sessions.delete(userId);
    if (sessions.size === 0) {
      groupActiveSessions.delete(groupId);
    }
    io.to(groupId).emit('member-session-ended', { groupId, userId });
  }
};




/**
 * Socket authentication middleware
 */
const authenticateSocket = async (socket: Socket): Promise<string | null> => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

    if (!token) {
      LoggerUtil.warn(`⚠️  No token provided for socket: ${socket.id}`);
      return null;
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;

    // Verify user exists and is active
    // BUG FIX: must select 'status' — selecting '_id isActive' left status=undefined,
    // so user.status !== 'active' was always true → blocked ALL socket connections.
    const user = await User.findOne({ userId: decoded.userId }).select('userId status isActive');

    if (!user || user.status !== 'active') {
      LoggerUtil.warn(`⚠️  Invalid or inactive user for socket: ${socket.id}`);
      return null;
    }

    return decoded.userId;
  } catch (error: any) {
    LoggerUtil.error(`❌ Socket authentication error: ${error.message}`);
    return null;
  }
};

/**
 * Verify user is a member of the group
 */
const verifyGroupMembership = async (
  userId: string,
  groupId: string
): Promise<boolean> => {
  try {
    // OLD: wrong field names — GroupMember model uses userId/groupId, not user/group
    // const membership = await GroupMember.findOne({
    //   user: userId,
    //   group: groupId,
    //   status: 'active',
    // });

    // NEW: correct field names matching GroupMember model schema
    const membership = await GroupMember.findOne({
      userId: userId,
      groupId: groupId,
      status: 'active',
    });

    return !!membership;
  } catch (error : any) {
    LoggerUtil.error(`❌ Error verifying group membership:`, error);
    return false;
  }
};

/**
 * Initialize StudyGroup real-time session, active tracking and presence handlers
 */
export const setupStudyGroupSessionHandlers = (
  io: Server,
  socket: Socket,
  userId: string
): void => {
  // Store socket connection
  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }
  userSockets.get(userId)!.add(socket.id);
  socketUsers.set(socket.id, userId);

  LoggerUtil.info(`✅ User ${userId} connected via socket ${socket.id}`);
  LoggerUtil.info(`👥 Total active sockets for user ${userId}: ${userSockets.get(userId)!.size}`);

  // Attach userId to socket
  socket.data.userId = userId;
  (socket as any).userId = userId;

  // Get user details for live room handler
  User.findOne({ userId })
    .select('username name firstName lastName')
    .then((user) => {
      const userName =
        user?.username ||
        (user as any)?.name ||
        ((user as any)?.firstName ? `${(user as any).firstName} ${(user as any).lastName || ''}`.trim() : '') ||
        'Unknown User';
      socket.data.userName = userName;
      (socket as any).userName = userName;
    })
    .catch((err) => {
      LoggerUtil.error(`Failed to fetch user name for socket: ${err.message}`);
    });


    // ==========================================
    // JOIN GROUP ROOM
    // ==========================================
    socket.on('join-group', async (groupId: string) => {
      try {
        LoggerUtil.info(`📥 User ${userId} attempting to join group: ${groupId}`);

        // Verify membership
        const isMember = await verifyGroupMembership(userId, groupId);

        if (!isMember) {
          LoggerUtil.warn(`⚠️  User ${userId} is not a member of group ${groupId}`);
          socket.emit('error', { 
            event: 'join-group',
            message: 'You are not a member of this group' 
          });
          return;
        }

        // Join socket room
        socket.join(groupId);

        // Track group room membership
        if (!groupRooms.has(groupId)) {
          groupRooms.set(groupId, new Set());
        }
        groupRooms.get(groupId)!.add(userId);

        LoggerUtil.info(`✅ User ${userId} joined group room: ${groupId}`);
        
        // Notify user
        socket.emit('joined-group', { 
          groupId,
          message: 'Successfully joined group room' 
        });

        // Notify others in the group
        socket.to(groupId).emit('user-joined-group', {
          userId,
          groupId,
          timestamp: new Date(),
        });

        // Send online status to group members
        io.to(groupId).emit('user-online', {
          userId,
          timestamp: new Date(),
        });

        // Send current active study members to the joined user
        const sessions = groupActiveSessions.get(groupId);
        const now = Date.now();
        const activeList: { userId: string; elapsedTime: number }[] = [];
        if (sessions) {
          sessions.forEach((val, uId) => {
            if (now - val.lastSeen <= 90000) {
              activeList.push({ userId: uId, elapsedTime: val.elapsedTime });
            } else {
              sessions.delete(uId);
            }
          });
        }
        socket.emit('active-members', {
          groupId,
          members: activeList,
        });

      } catch (error: any) {
        LoggerUtil.error(`❌ Error joining group:`, error);
        socket.emit('error', { 
          event: 'join-group',
          message: 'Failed to join group' 
        });
      }
    });

    // ==========================================
    // LEAVE GROUP ROOM
    // ==========================================
    socket.on('leave-group', async (groupId: string) => {
      try {
        LoggerUtil.info(`📤 User ${userId} leaving group: ${groupId}`);

        socket.leave(groupId);

        // Remove from group room tracking
        if (groupRooms.has(groupId)) {
          groupRooms.get(groupId)!.delete(userId);
          if (groupRooms.get(groupId)!.size === 0) {
            groupRooms.delete(groupId);
          }
        }

        LoggerUtil.info(`✅ User ${userId} left group room: ${groupId}`);

        // Notify user
        socket.emit('left-group', { 
          groupId,
          message: 'Successfully left group room' 
        });

        // Remove active session if any
        removeUserActiveSession(groupId, userId, io);

        // Notify others in the group
        socket.to(groupId).emit('user-left-group', {
          userId,
          groupId,
          timestamp: new Date(),
        });

      } catch (error: any) {
        LoggerUtil.error(`❌ Error leaving group:`, error);
        socket.emit('error', { 
          event: 'leave-group',
          message: 'Failed to leave group' 
        });
      }
    });

    // ==========================================
    // GET ACTIVE MEMBERS
    // ==========================================
    socket.on('get-active-members', async (data: { groupId: string } | string) => {
      try {
        const targetGroupId = typeof data === 'string' ? data : data?.groupId;
        if (!targetGroupId || typeof targetGroupId !== 'string') return;

        // Security: verify membership
        const isMember = await verifyGroupMembership(userId, targetGroupId);
        if (!isMember) {
          socket.emit('error', {
            event: 'get-active-members',
            message: 'You are not a member of this group',
          });
          return;
        }

        const now = Date.now();
        const sessions = groupActiveSessions.get(targetGroupId);
        const activeList: { userId: string; elapsedTime: number }[] = [];
        if (sessions) {
          sessions.forEach((val, uId) => {
            if (now - val.lastSeen <= 90000) {
              activeList.push({ userId: uId, elapsedTime: val.elapsedTime });
            } else {
              sessions.delete(uId);
            }
          });
        }
        socket.emit('active-members', {
          groupId: targetGroupId,
          members: activeList,
        });
      } catch (err: any) {
        LoggerUtil.error('❌ Error handling get-active-members:', err);
      }
    });

    // ==========================================
    // SESSION PAUSED
    // ==========================================
    socket.on('session-paused', async (data: { groupId: string } | string) => {
      try {
        const targetGroupId = typeof data === 'string' ? data : data?.groupId;
        if (!targetGroupId || typeof targetGroupId !== 'string') return;

        // Security: verify membership
        const isMember = await verifyGroupMembership(userId, targetGroupId);
        if (!isMember) return;

        const sessions = groupActiveSessions.get(targetGroupId);
        if (sessions) {
          sessions.delete(userId);
        }
        socket.to(targetGroupId).emit('member-session-paused', {
          groupId: targetGroupId,
          userId,
        });
      } catch (err: any) {
        LoggerUtil.error('❌ Error handling session-paused:', err);
      }
    });

    // ==========================================
    // BROADCAST SESSION TIME
    // ==========================================
    socket.on('broadcast-session-time', async (data: { groupId: string; elapsedTime: number }) => {
      try {
        if (
          !data?.groupId ||
          typeof data.groupId !== 'string' ||
          typeof data.elapsedTime !== 'number' ||
          !Number.isFinite(data.elapsedTime) ||
          data.elapsedTime < 0
        ) {
          return;
        }

        // Rate limiting: at most once every 3 seconds per socket
        const now = Date.now();
        const last = socketBroadcastRateLimit.get(socket.id) || 0;
        if (now - last < 3000) {
          return;
        }
        socketBroadcastRateLimit.set(socket.id, now);

        // Verify group membership
        const isMember = await verifyGroupMembership(userId, data.groupId);
        if (!isMember) return;

        if (!groupActiveSessions.has(data.groupId)) {
          groupActiveSessions.set(data.groupId, new Map());
        }
        groupActiveSessions.get(data.groupId)!.set(userId, {
          lastSeen: now,
          elapsedTime: data.elapsedTime,
        });

        socket.to(data.groupId).emit('member-session-update', {
          groupId: data.groupId,
          userId,
          elapsedTime: data.elapsedTime,
          timestamp: now,
        });
      } catch (err: any) {
        LoggerUtil.error('❌ Error handling broadcast-session-time:', err);
      }
    });

  // ==========================================
  // TYPING EVENTS
  // ==========================================
  handleTypingEvents(socket, userId);

  // ==========================================
  // DISCONNECT
  // ==========================================
  socket.on('disconnect', (reason) => {
    LoggerUtil.info(`🔌 Socket disconnected: ${socket.id}, Reason: ${reason}`);

    // Remove socket from tracking and rate limiter
    socketBroadcastRateLimit.delete(socket.id);

    if (userSockets.has(userId)) {
      userSockets.get(userId)!.delete(socket.id);
      if (userSockets.get(userId)!.size === 0) {
        userSockets.delete(userId);
        
        // User is completely offline
        LoggerUtil.info(`👋 User ${userId} is now offline (all sockets disconnected)`);

        // Notify all groups where user was present and remove active sessions
        groupRooms.forEach((members, groupId) => {
          if (members.has(userId)) {
            io.to(groupId).emit('user-offline', {
              userId,
              lastSeen: new Date(),
            });
            members.delete(userId);
            removeUserActiveSession(groupId, userId, io);
          }
        });
      }
    }

    socketUsers.delete(socket.id);

    LoggerUtil.info(`👥 Remaining active connections for user ${userId}: ${userSockets.get(userId)?.size || 0}`);
  });

  // ==========================================
  // ERROR HANDLING
  // ==========================================
  socket.on('error', (error) => {
    LoggerUtil.error(`❌ Socket error on ${socket.id}:`, error);
  });
};

/**
 * Initialize Socket.io event handlers (legacy wrapper)
 */
export const setupSocketHandlers = (io: Server): void => {
  io.on('connection', async (socket: Socket) => {
    const userId = await authenticateSocket(socket);
    if (!userId) return;
    setupStudyGroupSessionHandlers(io, socket, userId);
  });
};

/**
 * Get socket IDs for a user
 */
export const getUserSockets = (userId: string): Set<string> => {
  return userSockets.get(userId) || new Set();
};

/**
 * Get user ID from socket ID
 */
export const getUserFromSocket = (socketId: string): string | undefined => {
  return socketUsers.get(socketId);
};

/**
 * Check if user is online
 */
export const isUserOnline = (userId: string): boolean => {
  return userSockets.has(userId) && userSockets.get(userId)!.size > 0;
};

/**
 * Get all online users in a group
 */
export const getOnlineUsersInGroup = (groupId: string): string[] => {
  const members = groupRooms.get(groupId);
  return members ? Array.from(members) : [];
};

/**
 * Emit to all sockets of a user
 */
export const emitToUser = (io: Server, userId: string, event: string, data: any): void => {
  const sockets = getUserSockets(userId);
  sockets.forEach((socketId) => {
    io.to(socketId).emit(event, data);
  });
};

export default {
  setupSocketHandlers,
  getUserSockets,
  getUserFromSocket,
  isUserOnline,
  getOnlineUsersInGroup,
  emitToUser,
};