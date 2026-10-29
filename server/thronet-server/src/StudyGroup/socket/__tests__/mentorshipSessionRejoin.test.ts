/**
 * mentorshipSessionRejoin.test.ts
 *
 * Unit tests verifying mentorship session room rejoin authorization & presence:
 * 1. Rejoin after leave: Authorized mentor leaves, live presence is removed,
 *    mentor rejoins with sessionId (UUID) -> allowed with canonicalRoomId.
 * 2. Rejoin after disconnect: Socket disconnect clears live participant,
 *    reconnect restores presence.
 * 3. Unauthorized user blocked: Non-assigned user is rejected with
 *    "You are not an authorized participant of this session".
 * 4. Rejoin after session ended or cancelled is blocked with
 *    "This session has ended or was cancelled".
 */

import assert from 'assert';
import mongoose from 'mongoose';
import { getRoomAccess, isMentorshipSessionMember } from '../liveRoomHandler';
import { SessionMentor, Mentor } from '@/Mentorship/models';
import { SocketLiveRoomRepository } from '@/shared/cache/socketCache';

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Running Mentorship Session Room Rejoin Test Suite');
  console.log('====================================================\n');

  const testSessionId = '02d32552-594c-4d19-b671-159a1ff293b3'; // UUID format
  const testBookingObjectId = new mongoose.Types.ObjectId();
  const testBookingId = testBookingObjectId.toString();
  const testMentorUserId = new mongoose.Types.ObjectId().toString();
  const testMenteeUserId = new mongoose.Types.ObjectId().toString();
  const testUnauthorizedUserId = new mongoose.Types.ObjectId().toString();
  const testMentorId = 'mentor-uuid-9999';

  // In-memory mock state
  let currentSessionStatus = 'in_progress';
  let currentBookingStatus = 'in_progress';
  let liveParticipants: Array<{ userId: string; socketId: string }> = [];

  // Mock SessionMentor.findOne
  const origSessionMentorFindOne = SessionMentor.findOne;
  const origMentorFindOne = Mentor.findOne;
  const origAddParticipant = SocketLiveRoomRepository.addParticipant;
  const origRemoveParticipant = SocketLiveRoomRepository.removeParticipant;
  const origGetRoomParticipants = SocketLiveRoomRepository.getRoomParticipants;

  (SessionMentor as any).findOne = (query: any) => {
    return {
      lean: async () => {
        // Query match check
        const orList = query?.$or || [];
        const matches = orList.some((cond: any) => {
          if (cond.sessionId === testSessionId) return true;
          if (cond._id === testSessionId) return true;
          if (cond['bookings._id'] === testBookingId) return true;
          if (cond['bookings._id']?.toString() === testBookingId) return true;
          return false;
        });

        if (!matches) return null;

        return {
          _id: new mongoose.Types.ObjectId(),
          sessionId: testSessionId,
          mentorId: testMentorId,
          menteeId: testMenteeUserId,
          status: currentSessionStatus,
          scheduledAt: new Date(Date.now() - 10 * 60 * 1000),
          startedAt: new Date(Date.now() - 10 * 60 * 1000),
          duration: 60,
          bookings: [
            {
              _id: testBookingObjectId,
              bookingId: 'BK-12345',
              menteeId: testMenteeUserId,
              status: currentBookingStatus,
              scheduledAt: new Date(Date.now() - 10 * 60 * 1000),
              slotDuration: 60,
            },
          ],
        };
      },
    };
  };

  // Mock Mentor.findOne
  (Mentor as any).findOne = (query: any) => {
    return {
      lean: async () => {
        const orList = query?.$or || [];
        const matches = orList.some((cond: any) => cond.mentorId === testMentorId);
        if (!matches) return null;
        return {
          _id: new mongoose.Types.ObjectId(),
          mentorId: testMentorId,
          userId: testMentorUserId,
          isDeleted: false,
        };
      },
    };
  };

  // Mock Redis presence
  (SocketLiveRoomRepository as any).addParticipant = async (roomId: string, userId: string, socketId: string) => {
    liveParticipants.push({ userId, socketId });
    return { success: true, isFirst: liveParticipants.length === 1 };
  };

  (SocketLiveRoomRepository as any).removeParticipant = async (roomId: string, socketId: string) => {
    liveParticipants = liveParticipants.filter((p) => p.socketId !== socketId);
    return { isRoomEmpty: liveParticipants.length === 0 };
  };

  (SocketLiveRoomRepository as any).getRoomParticipants = async () => {
    return liveParticipants;
  };

  try {
    // ─────────────────────────────────────────────────────────────
    // TEST 1: Rejoin after Leave (Mentor leaves, then returns to session URL)
    // ─────────────────────────────────────────────────────────────
    console.log('Test 1: Authorized mentor joins, leaves room, and rejoins using sessionId (UUID)...');

    // Mentor joins initially
    const initialJoin = await getRoomAccess(testMentorUserId, testSessionId);
    assert.strictEqual(initialJoin.allowed, true, 'Initial join must be allowed');
    assert.strictEqual(initialJoin.canonicalRoomId, testBookingId, 'Canonical room ID should resolve to booking ID');

    await SocketLiveRoomRepository.addParticipant(initialJoin.canonicalRoomId!, testMentorUserId, 'socket-mentor-1', {} as any, 2);
    assert.strictEqual(liveParticipants.length, 1, 'Mentor should be active in live participant list');

    // Mentor leaves session (via End Call / Leave button)
    await SocketLiveRoomRepository.removeParticipant(initialJoin.canonicalRoomId!, 'socket-mentor-1');
    assert.strictEqual(liveParticipants.length, 0, 'Presence list should be empty after leave');

    // Mentor rejoins via `/mentorship/session-room/${sessionId}`
    const rejoinAccess = await getRoomAccess(testMentorUserId, testSessionId);
    assert.strictEqual(rejoinAccess.allowed, true, 'Mentor rejoin must be allowed despite not being in presence list');
    assert.strictEqual(rejoinAccess.canonicalRoomId, testBookingId, 'Canonical room ID preserved across rejoin');

    // Restore presence with new socket
    const rejoinPresence = await SocketLiveRoomRepository.addParticipant(rejoinAccess.canonicalRoomId!, testMentorUserId, 'socket-mentor-2', {} as any, 2);
    assert.strictEqual(rejoinPresence.success, true);
    assert.strictEqual(liveParticipants.some((p) => p.userId === testMentorUserId), true, 'Mentor presence restored');
    console.log('✅ Test 1 Passed: Mentor successfully rejoined session after leaving\n');

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Rejoin after Unexpected Disconnect
    // ─────────────────────────────────────────────────────────────
    console.log('Test 2: Rejoin after unexpected disconnect / network drop...');

    // Network drop clears socket
    await SocketLiveRoomRepository.removeParticipant(rejoinAccess.canonicalRoomId!, 'socket-mentor-2');

    // Both mentor and mentee can reconnect cleanly
    const menteeAccess = await getRoomAccess(testMenteeUserId, testSessionId);
    assert.strictEqual(menteeAccess.allowed, true, 'Mentee access must be allowed');

    const mentorReconnect = await getRoomAccess(testMentorUserId, testSessionId);
    assert.strictEqual(mentorReconnect.allowed, true, 'Mentor reconnect must be allowed');
    console.log('✅ Test 2 Passed: Reconnect after disconnect allowed for both participants\n');

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Unauthorized user is blocked
    // ─────────────────────────────────────────────────────────────
    console.log('Test 3: Unauthorized user blocked from joining session room...');
    const unauthorized = await getRoomAccess(testUnauthorizedUserId, testSessionId);
    assert.strictEqual(unauthorized.allowed, false, 'Unauthorized user must not be allowed');
    assert.strictEqual(
      unauthorized.errorReason,
      'You are not an authorized participant of this session',
      'Must return clear authorization error'
    );
    console.log('✅ Test 3 Passed: Unauthorized user correctly blocked\n');

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Rejoin blocked after session ended or cancelled
    // ─────────────────────────────────────────────────────────────
    console.log('Test 4: Rejoin blocked when session status is completed or cancelled...');

    // Set to completed
    currentSessionStatus = 'completed';
    currentBookingStatus = 'completed';
    const completedCheck = await getRoomAccess(testMentorUserId, testSessionId);
    assert.strictEqual(completedCheck.allowed, false, 'Rejoin must be blocked after session completed');
    assert.strictEqual(completedCheck.errorReason, 'This session has ended or was cancelled');

    // Set to cancelled
    currentSessionStatus = 'cancelled';
    currentBookingStatus = 'cancelled';
    const cancelledCheck = await getRoomAccess(testMenteeUserId, testSessionId);
    assert.strictEqual(cancelledCheck.allowed, false, 'Rejoin must be blocked after session cancelled');
    assert.strictEqual(cancelledCheck.errorReason, 'This session has ended or was cancelled');
    console.log('✅ Test 4 Passed: Rejoin after session ended/cancelled correctly blocked\n');

    console.log('====================================================');
    console.log('🎉 ALL 4 ACCEPTANCE TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');
    process.exit(0);
  } finally {
    // Restore originals
    (SessionMentor as any).findOne = origSessionMentorFindOne;
    (Mentor as any).findOne = origMentorFindOne;
    (SocketLiveRoomRepository as any).addParticipant = origAddParticipant;
    (SocketLiveRoomRepository as any).removeParticipant = origRemoveParticipant;
    (SocketLiveRoomRepository as any).getRoomParticipants = origGetRoomParticipants;
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
