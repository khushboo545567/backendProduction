// src/Mentorship/utils/slotSplitter.ts
//
// Pure helper functions (no DB calls) jo stored availability slots ko
// service ke duration ke hisaab se todte / wapas free karte hain.
//
// Example: stored slot 20:00-20:45, mentee books 20:10-20:20
//   -> 20:00-20:10 (free) | 20:10-20:20 (booked) | 20:20-20:45 (free)

export interface SlotLike {
    startTime: string;
    endTime: string;
    isBooked?: boolean;
    isBlocked?: boolean;
    sessionId?: string;
    blockReason?: string;
  }
  
  export const toMinutes = (time: string): number => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };
  
  export const toTimeString = (minutes: number): string => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  
  export const computeEndTime = (startTime: string, durationMinutes: number): string =>
    toTimeString(toMinutes(startTime) + durationMinutes);
  
  const sortSlots = <T extends { startTime: string }>(slots: T[]): T[] =>
    [...slots].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  
  /**
   * [startTime, endTime) range ko book karta hai.
   *
   * Rules:
   *  - Range ke andar aane wale saare stored slots free hone chahiye (na booked, na blocked)
   *  - Range poori tarah continuous free slots se cover honi chahiye (beech mein gap nahi)
   *
   * Success par naya slots array return karta hai (bacha hua free hissa alag slots mein).
   * Kuch bhi galat ho to null return karta hai.
   */
  export function bookRangeInSlots(
    slots: SlotLike[],
    startTime: string,
    endTime: string,
    sessionId: string
  ): SlotLike[] | null {
    const s = toMinutes(startTime);
    const e = toMinutes(endTime);
    if (!(s < e)) return null;
  
    const sorted = sortSlots(slots.map((slot) => ({ ...slot })));
  
    const overlapping = sorted.filter(
      (slot) => toMinutes(slot.startTime) < e && toMinutes(slot.endTime) > s
    );
    if (overlapping.length === 0) return null;
    if (overlapping.some((slot) => slot.isBooked || slot.isBlocked)) return null;
  
    const first = overlapping[0];
    const last = overlapping[overlapping.length - 1];
  
    // Range poori tarah covered honi chahiye
    if (toMinutes(first.startTime) > s || toMinutes(last.endTime) < e) return null;
    for (let i = 1; i < overlapping.length; i++) {
      if (toMinutes(overlapping[i].startTime) > toMinutes(overlapping[i - 1].endTime)) {
        return null; // beech mein gap
      }
    }
  
    const result: SlotLike[] = sorted.filter((slot) => !overlapping.includes(slot));
  
    if (toMinutes(first.startTime) < s) {
      result.push({ startTime: first.startTime, endTime: toTimeString(s), isBooked: false, isBlocked: false });
    }
  
    result.push({
      startTime: toTimeString(s),
      endTime: toTimeString(e),
      isBooked: true,
      isBlocked: false,
      sessionId,
    });
  
    if (toMinutes(last.endTime) > e) {
      result.push({ startTime: toTimeString(e), endTime: last.endTime, isBooked: false, isBlocked: false });
    }
  
    return sortSlots(result);
  }
  
  /**
   * Exact [startTime, endTime) wale booked slot ko wapas free karta hai.
   * Agar us date par poori date blocked hai to released slot bhi blocked rehta hai.
   * Koi matching booked slot na mile to null return karta hai.
   */
  export function releaseRangeInSlots(
    slots: SlotLike[],
    startTime: string,
    endTime: string,
    blockAfterRelease?: { reason?: string }
  ): SlotLike[] | null {
    const s = toMinutes(startTime);
    const e = toMinutes(endTime);
    let found = false;
  
    const result: SlotLike[] = slots.map((slot) => {
      if (
        !found &&
        slot.isBooked &&
        toMinutes(slot.startTime) === s &&
        toMinutes(slot.endTime) === e
      ) {
        found = true;
        return {
          startTime: slot.startTime,
          endTime: slot.endTime,
          isBooked: false,
          isBlocked: !!blockAfterRelease,
          blockReason: blockAfterRelease?.reason,
        };
      }
      return { ...slot };
    });
  
    return found ? sortSlots(result) : null;
  }
  
  /**
   * Incoming slots mein se busy (booked/blocked) ranges ko minus karta hai.
   * Mentor availability update karte waqt booked time ke upar naye slots overlap
   * na ho, is liye use hota hai.
   */
  export function subtractBusyRanges<T extends { startTime: string; endTime: string }>(
    incoming: T[],
    busy: Array<{ startTime: string; endTime: string }>
  ): T[] {
    const busyRanges = busy
      .map((b) => ({ s: toMinutes(b.startTime), e: toMinutes(b.endTime) }))
      .sort((a, b) => a.s - b.s);
  
    const out: T[] = [];
  
    for (const slot of incoming) {
      let pieces = [{ s: toMinutes(slot.startTime), e: toMinutes(slot.endTime) }];
  
      for (const b of busyRanges) {
        pieces = pieces.flatMap((p) => {
          if (b.e <= p.s || b.s >= p.e) return [p]; // overlap nahi
          const rest: Array<{ s: number; e: number }> = [];
          if (p.s < b.s) rest.push({ s: p.s, e: b.s });
          if (b.e < p.e) rest.push({ s: b.e, e: p.e });
          return rest;
        });
      }
  
      pieces.forEach((p) =>
        out.push({ ...slot, startTime: toTimeString(p.s), endTime: toTimeString(p.e) })
      );
    }
  
    return out;
  }