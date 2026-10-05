import { Hono } from 'hono';
import { html } from 'hono/html';
import { createSlot, allSlots } from '../slots.js';
import { allBookings } from '../bookings.js';
import { listUsers, setPlan } from '../users.js';
import { parseDollars, formatCents } from '../money.js';
import { formatWhen } from '../time.js';
import { page } from '../views.js';

export function adminRoutes() {
  const r = new Hono();
  r.use('*', async (c, next) => (c.var.user?.role === 'admin' ? next() : c.text('admins only', 403)));
  r.get('/', async (c) => {
    const { db, user } = c.var;
    const [slots, bookings, users] = await Promise.all([allSlots(db), allBookings(db), listUsers(db)]);
    return c.html(page('Admin', user, html`
      <h2>Slots</h2><table>${slots.map((s) => html`<tr><td>${formatWhen(s.starts_at, user.timezone)}</td><td>${s.title}</td><td>${formatCents(s.price_cents)}</td><td>${s.booked ? 'booked' : 'open'}</td></tr>`)}</table>
      <form method="post" action="/admin/slots"><input name="startsAt" placeholder="2026-11-01T15:00Z"> <input name="title" placeholder="Title"> <input name="price" placeholder="$0"> <button>Add slot</button></form>
      <h2>Bookings</h2><table>${bookings.map((b) => html`<tr><td>${formatWhen(b.starts_at, user.timezone)}</td><td>${b.title}</td><td>${b.name} &lt;${b.email}&gt;</td><td>${b.status}</td></tr>`)}</table>
      <h2>Customers</h2><table>${users.map((u) => html`<tr><td>${u.name}</td><td>${u.email}</td><td>${u.plan}</td></tr>`)}</table>`));
  });
  r.post('/slots', async (c) => {
    const f = await c.req.parseBody();
    try { await createSlot(c.var.db, { startsAt: Date.parse(f.startsAt), title: f.title, priceCents: f.price ? parseDollars(f.price) : 0 }, c.var.now()); }
    catch (e) { return c.text(e.message, 400); }
    return c.redirect('/admin');
  });
  r.post('/users/:id/plan', async (c) => {
    const { plan } = await c.req.parseBody();
    if (!['free', 'pro'].includes(plan)) return c.text('unknown plan', 400);
    await setPlan(c.var.db, Number(c.req.param('id')), plan);
    return c.redirect('/admin');
  });
  return r;
}
