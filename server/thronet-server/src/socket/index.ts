/**
 * ====================================
 * SOCKET.IO — MAIN ENTRY POINT
 * ====================================
 * server/thronet-server/src/socket/index.ts
 *
 * - Core (hamesha on): notifications, mentorship, StudyGroup chat events
 * - Optional (feature flag): connections, messaging, live room, presence
 * - Disabled handlers load hi nahi hote
 * - Auto-join user:{userId} room on connect
 * - Disconnect cleanup centralized here
 */

import { Server as HTTPServer } from 'http';
import { Server } from 'socket.io';
import { socketAuthMiddleware } from './middleware/auth.socket.middleware';
import { setupNotificationHandlers } from './handlers/notificationHandler';
import { setupMentorshipHandlers } from './handlers/mentorshipHandler';
import { LoggerUtil } from '@/shared/logger.util';
import { handleChatEvents } from '@/StudyGroup/socket/chatHandler';
import { FEATURES } from '@/config/features';
import { AuthenticatedSocket } from './types';
export type { AuthenticatedSocket } from './types';
import { setIO } from './emitter';

// ─── CORS ─────────────────────────────────────────────────────────────────────
// app.ts jaisi logic: production me sirf CORS_ORIGIN / ALLOWED_ORIGINS wali list.
const isProduction = process.env['NODE_ENV'] === 'production';

const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://throne8-client-main.vercel.app',
];

const envOrigins = process.env['CORS_ORIGIN'] || process.env['ALLOWED_ORIGINS'] || '';
const allowedOrigins: string[] = envOrigins
  ? envOrigins.split(',').map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;

const allowVercelPreviews = process.env['ALLOW_VERCEL_PREVIEWS']
  ? process.env['ALLOW_VERCEL_PREVIEWS'] === 'true'
  : !isProduction;

const isOriginAllowed = (origin?: string): boolean => {
  if (!origin) return true; // server-to-server / native clients
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  if (allowVercelPreviews && /\.vercel\.app$/.test(origin)) return true;
  if (!isProduction && /^http:\/\/localhost:\d+$/.test(origin)) return true;
  return false;
};

// ─── Initialize ───────────────────────────────────────────────────────────────
export const initializeSocketIO = (httpServer: HTTPServer): Server => {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'), false);
        }
      },
      methods: ['GET', 'POST'],
      credentials: true,
      allowedHeaders: ['Authorization'],
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60_000,
    pingInterval: 25_000,
    allowEIO3: true,
    // Prevent event flooding from a single socket
    maxHttpBufferSize: 1e6, // 1 MB
  });

  // ── Optional handlers: sirf enabled features ke liye load honge ─────────────
  /* eslint-disable @typescript-eslint/no-var-requires */
  const connectionHandlers = FEATURES.connections
    ? require('./handlers/connectionHandler')
    : null;

  const messageHandlers = FEATURES.messaging
    ? require('./handlers/messageHandler')
    : null;

  const liveRoom = FEATURES.studyGroup
    ? require('../StudyGroup/socket/liveRoomHandler')
    : null;

  // Presence online/offline status deta hai, jab in me se koi feature on ho
  const presence =
    FEATURES.studyGroup || FEATURES.messaging || FEATURES.connections
      ? require('../StudyGroup/socket/presenceHandler')
      : null;
  /* eslint-enable @typescript-eslint/no-var-requires */

  LoggerUtil.info('Socket handlers configured', {
    connections: !!connectionHandlers,
    messaging: !!messageHandlers,
    liveRoom: !!liveRoom,
    presence: !!presence,
  });

  // ── Auth middleware ──────────────────────────────────────────────────────────
  io.use((socket, next) => {
    socketAuthMiddleware(socket, next);
  });

  // ── Connection ───────────────────────────────────────────────────────────────
  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.data.userId;

    // Guard — middleware ne unauthenticated sockets reject kar diye honge,
    // phir bhi double-check taaki handlers bina userId ke na chalen.
    if (!userId) {
      LoggerUtil.error('Socket connected without userId — disconnecting', {
        socketId: socket.id,
      });
      socket.disconnect(true);
      return;
    }

    LoggerUtil.info('Socket connected', {
      socketId: socket.id,
      userId,
      email: socket.data.email,
    });

    // ── Auto-join personal notification room ─────────────────────────────────
    // Server-side join, taaki notifications delivery client pe depend na kare.
    socket.join(`user:${userId}`);

    // ── Core handlers (hamesha on) ───────────────────────────────────────────
    setupNotificationHandlers(io, socket);
    setupMentorshipHandlers(io, socket);

    // StudyGroup chat events: mentorship community isi handler pe depend kar
    // sakta hai (community.service.ts ka comment dekho), isliye always on.
    handleChatEvents(io, socket, userId);

    // ── Optional handlers ────────────────────────────────────────────────────
    if (connectionHandlers) {
      connectionHandlers.setupConnectionHandlers(io, socket);
    }
    if (messageHandlers) {
      messageHandlers.setupMessageHandlers(io, socket);
    }
    if (liveRoom) {
      liveRoom.liveRoomHandler(io, socket as any);
    }
    if (presence) {
      presence.handlePresenceEvents(io, socket, userId);
    }

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      LoggerUtil.info('Socket disconnected', {
        socketId: socket.id,
        userId,
        reason,
      });

      // Offline status broadcast sirf tab jab presence feature chalu ho
      if (presence) {
        io.to(`user:${userId}:contacts`).emit('user-status-changed', {
          userId,
          isOnline: false,
          lastActive: new Date(),
        });
      }
    });
  });

  LoggerUtil.info('Socket.IO initialized successfully');
  setIO(io);
  return io;
};