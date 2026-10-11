/**
 * ====================================
 * LIVE ROOM INTERFACE
 * ====================================
 * group, host and participants[].user are UUID strings (not ObjectIds).
 * The room's own _id stays an ObjectId.
 */

import { Document, Types } from 'mongoose';

export interface IParticipant {
  user: string;
  joinedAt: Date;
  leftAt?: Date | null;
  cameraOn: boolean;
  micOn: boolean;
  screenSharing: boolean;
  connectionQuality?: 'excellent' | 'good' | 'fair' | 'poor';
}

export interface ILiveRoom extends Document {
  _id: Types.ObjectId;
  group: string;
  title: string;
  description?: string;
  host: string;
  participants: IParticipant[];
  maxParticipants: number;
  isActive: boolean;
  startedAt: Date;
  endedAt?: Date | null;
  duration?: number; // in minutes
  recordingUrl?: string | null;
  isRecording: boolean;
  settings: {
    allowCamera: boolean;
    allowMic: boolean;
    allowScreenShare: boolean;
    requireApproval: boolean;
    muteOnEntry: boolean;
  };
  stats: {
    totalParticipants: number;
    peakParticipants: number;
    totalDuration: number; // in minutes
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface ILiveRoomMethods {
  addParticipant(userId: string): Promise<void>;
  removeParticipant(userId: string): Promise<void>;
  toggleCamera(userId: string, cameraOn: boolean): Promise<void>;
  toggleMic(userId: string, micOn: boolean): Promise<void>;
  toggleScreenShare(userId: string, sharing: boolean): Promise<void>;
  endSession(): Promise<void>;
  getActiveParticipants(): IParticipant[];
}

export type ILiveRoomDocument = ILiveRoom & ILiveRoomMethods;