import { first, run, all } from './db.js';

export async function createUser(db, { email, name, role = 'customer', timezone = 'UTC' }, now = Date.now()) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('a valid email is required');
  if (!name?.trim()) throw new Error('a name is required');
  const r = await run(db, 'INSERT INTO users (email, name, role, timezone, created_at) VALUES (?, ?, ?, ?, ?)', email.toLowerCase(), name.trim(), role, timezone, now);
  return getUser(db, r.meta.last_row_id);
}
export const getUser = (db, id) => first(db, 'SELECT * FROM users WHERE id = ?', id);
export const findByEmail = (db, email) => first(db, 'SELECT * FROM users WHERE email = ?', String(email).toLowerCase());
export const listUsers = (db) => all(db, 'SELECT * FROM users ORDER BY id');
export async function updateSettings(db, id, { name, timezone }) {
  if (timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new Error(`unknown timezone: ${timezone}`); } }
  await run(db, 'UPDATE users SET name = COALESCE(?, name), timezone = COALESCE(?, timezone) WHERE id = ?', name?.trim() || null, timezone || null, id);
  return getUser(db, id);
}
export async function setPlan(db, id, plan) {
  await run(db, 'UPDATE users SET plan = ? WHERE id = ?', plan, id);
  return getUser(db, id);
}
