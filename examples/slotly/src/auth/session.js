import { first, run } from '../db.js';
import { getUser } from '../users.js';
import { DAY } from '../time.js';

// Sign-in is a magic link in production; sessions are opaque random tokens kept in D1.
export async function createSession(db, userId, now = Date.now()) {
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await run(db, 'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, now + 30 * DAY);
  return token;
}
export async function userForToken(db, token, now = Date.now()) {
  if (!token) return null;
  const s = await first(db, 'SELECT * FROM sessions WHERE token = ? AND expires_at > ?', token, now);
  return s ? getUser(db, s.user_id) : null;
}
export const endSession = (db, token) => run(db, 'DELETE FROM sessions WHERE token = ?', token);
