import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, fakeMail, seed, NOW } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/auth/session.js';

async function setup() {
  const db = testDb(); const people = await seed(db); const mail = fakeMail();
  const app = createApp({ db, mailProvider: mail, now: () => NOW });
  const as = async (user) => ({ cookie: `session=${await createSession(db, user.id, NOW)}` });
  return { db, app, mail, as, ...people };
}

test('the home page lists open times', async () => {
  const { app } = await setup();
  const html = await (await app.request('/')).text();
  assert.match(html, /Haircut/); assert.match(html, /\$35\.00/); assert.match(html, /Consultation/);
});

test('booking from the web sends a confirmation email in the customer\'s timezone', async () => {
  const { app, mail, as, ana, haircut } = await setup();
  const r = await app.request(`/book/${haircut.id}`, { method: 'POST', headers: await as(ana) });
  assert.equal(r.status, 302);
  assert.equal(mail.sent.length, 1); assert.equal(mail.sent[0].to, 'ana@example.com');
  assert.match(mail.sent[0].text, /Mon, Nov 2, 7:00 AM/); // 12:00 UTC is 7:00 in New York
});

test('settings update the name and timezone, and refuse unknown timezones', async () => {
  const { app, as, ben, db } = await setup();
  const h = { ...(await as(ben)), 'content-type': 'application/x-www-form-urlencoded' };
  assert.equal((await app.request('/settings', { method: 'POST', headers: h, body: 'name=Benjamin&timezone=Europe%2FLondon' })).status, 302);
  assert.equal((await db.prepare('SELECT timezone FROM users WHERE id = ?').bind(ben.id).first()).timezone, 'Europe/London');
  assert.equal((await app.request('/settings', { method: 'POST', headers: h, body: 'timezone=Mars%2FOlympus' })).status, 400);
});

test('admin pages are for admins only', async () => {
  const { app, as, ana, admin } = await setup();
  assert.equal((await app.request('/admin', { headers: await as(ana) })).status, 403);
  const html = await (await app.request('/admin', { headers: await as(admin) })).text();
  assert.match(html, /Bookings/); assert.match(html, /ana@example\.com/);
});

test('signing in emails a link and never says whether the account exists', async () => {
  const { app, mail } = await setup();
  const form = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  const yes = await (await app.request('/login', { ...form, body: 'email=ana%40example.com' })).text();
  const no = await (await app.request('/login', { ...form, body: 'email=nobody%40example.com' })).text();
  assert.equal(mail.sent.length, 1); assert.match(mail.sent[0].text, /\/login\/[0-9a-f]{48}/);
  assert.equal(yes.replace(/ana@example\.com/, 'X'), no.replace(/nobody@example\.com/, 'X'));
});
