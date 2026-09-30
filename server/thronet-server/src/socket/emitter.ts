import { Server } from 'socket.io';

let io: Server | null = null;

export const setIO = (instance: Server) => {
  io = instance;
};

export const getIO = (): Server => {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initializeSocketIO first.');
  }
  return io;
};

export const emitToUser = (
  userId: string,
  event: string,
  payload: Record<string, unknown>
): void => {
  getIO().to(`user:${userId}`).emit(event, payload);
};
