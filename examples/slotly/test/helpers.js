// An in-memory stand-in for D1 (node:sqlite, same prepare/bind/all/first/run shape) and a fake mail provider.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createUser } from '../src/users.js';
import { createSlot } from '../src/slots.js';
import { HOUR } from '../src/time.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

export function testDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
  });
  return { prepare: (sql) => statement(sql), sqlite };
}

export function fakeMail() {
  const sent = [];
  return { sent, fail: false, async send(m) { if (this.fail) throw new Error('mail provider is down'); sent.push(m); } };
}

export const NOW = Date.parse('2026-11-02T09:00:00Z');

export async function seed(db) {
  const admin = await createUser(db, { email: 'owner@slotly.app', name: 'Olu', role: 'admin' }, NOW);
  const ana = await createUser(db, { email: 'ana@example.com', name: 'Ana', timezone: 'America/New_York' }, NOW);
  const ben = await createUser(db, { email: 'ben@example.com', name: 'Ben' }, NOW);
  const haircut = await createSlot(db, { startsAt: NOW + 3 * HOUR, title: 'Haircut', priceCents: 3500 }, NOW);
  const consult = await createSlot(db, { startsAt: NOW + 26 * HOUR, title: 'Consultation' }, NOW);
  return { admin, ana, ben, haircut, consult };
}
