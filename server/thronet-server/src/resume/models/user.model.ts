/**
 * src/resume/models/user.model.ts
 * Adapter: reuse throne8-servers' existing User model instead of registering a duplicate.
 * The resume module only needs to reference User documents for foreign-key refs.
 */
import mongoose, { Document } from 'mongoose';

import User from '@/auth/models/User.model';

export { User };

// Minimal IUser type that resume controllers need
export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  // throne8 uses passwordHash; resume controllers never check password directly
}

export const UserRoles = { USER: 'user', ADMIN: 'admin' } as const;
export const UserStatus = { ACTIVE: 'active', SUSPENDED: 'suspended' } as const;
export type UserRole = typeof UserRoles[keyof typeof UserRoles];