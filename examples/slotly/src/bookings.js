import { all, first, run } from './db.js';
import { getSlot } from './slots.js';
import { getUser } from './users.js';
import { canBook } from './plans.js';
import { DAY } from './time.js';

export class BookingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function bookingsThisMonth(db, userId, now = Date.now()) {
  const r = await first(db, "SELECT count(*) AS n FROM bookings WHERE user_id = ? AND status = 'confirmed' AND created_at >= ?", userId, now - 30 * DAY);
  return r.n;
}

/** Book a slot for a user. */
export async function book(db, { slotId, userId, note }, now = Date.now()) {
  const slot = await getSlot(db, slotId);
  if (!slot) throw new BookingError('not-found', 'no such slot');
  if (slot.starts_at < now) throw new BookingError('past', 'that slot has already started');
  const user = await getUser(db, userId);
  if (!user) throw new BookingError('not-found', 'no such user');
  if (!canBook(user, await bookingsThisMonth(db, userId, now))) throw new BookingError('plan-limit', 'your plan has no bookings left this month');
  const taken = await first(db, "SELECT 1 AS x FROM bookings WHERE slot_id = ? AND status = 'confirmed'", slotId);
  if (taken) throw new BookingError('taken', 'that slot is already booked');
  const r = await run(db, 'INSERT INTO bookings (slot_id, user_id, note, created_at) VALUES (?, ?, ?, ?)', slotId, userId, note?.slice(0, 500) || null, now);
  return getBooking(db, r.meta.last_row_id);
}
export const getBooking = (db, id) => first(db, 'SELECT * FROM bookings WHERE id = ?', id);

export async function cancel(db, { bookingId, userId }) {
  const b = await getBooking(db, bookingId);
  if (!b || b.user_id !== userId) throw new BookingError('not-found', 'no such booking');
  await run(db, "UPDATE bookings SET status = 'cancelled' WHERE id = ?", bookingId);
  return getBooking(db, bookingId);
}

export function upcomingFor(db, userId, now = Date.now()) {
  return all(db, `SELECT b.*, s.starts_at, s.title, s.minutes FROM bookings b JOIN slots s ON s.id = b.slot_id
    WHERE b.user_id = ? AND b.status = 'confirmed' AND s.starts_at >= ? ORDER BY s.starts_at`, userId, now);
}
export function allBookings(db) {
  return all(db, `SELECT b.*, s.starts_at, s.title, s.price_cents, u.email, u.name FROM bookings b
    JOIN slots s ON s.id = b.slot_id JOIN users u ON u.id = b.user_id ORDER BY s.starts_at`);
}
