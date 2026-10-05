import { Hono } from 'hono';
import { openSlots, getSlot } from '../slots.js';
import { book, cancel, upcomingFor, BookingError } from '../bookings.js';
import { templates } from '../email.js';
import { html } from 'hono/html';
import { page, slotRow, bookingRow, empty } from '../views.js';

export function publicRoutes() {
  const r = new Hono();
  r.get('/', async (c) => {
    const { db, user, now } = c.var;
    const slots = await openSlots(db, now());
    return c.html(page('Book a time', user, slots.length ? html`<table>${slots.map((s) => slotRow(s, user))}</table>` : empty('No open times right now.')));
  });
  r.post('/book/:id', async (c) => {
    const { db, user, mailer, now } = c.var;
    if (!user) return c.redirect('/login');
    try {
      const b = await book(db, { slotId: Number(c.req.param('id')), userId: user.id }, now());
      const t = templates.confirmation(user, await getSlot(db, b.slot_id));
      await mailer.send({ to: user.email, ...t });
      return c.redirect('/me');
    } catch (e) {
      if (e instanceof BookingError) return c.html(page("Couldn't book that", user, html`<p>${e.message}</p><p><a href="/">Back</a></p>`), e.code === 'not-found' ? 404 : 409);
      throw e;
    }
  });
  r.get('/me', async (c) => {
    const { db, user, now } = c.var;
    if (!user) return c.redirect('/login');
    const list = await upcomingFor(db, user.id, now());
    return c.html(page('My bookings', user, list.length ? html`<table>${list.map((b) => bookingRow(b, user))}</table>` : empty('Nothing booked yet.')));
  });
  r.post('/cancel/:id', async (c) => {
    const { db, user, mailer } = c.var;
    if (!user) return c.redirect('/login');
    try {
      const b = await cancel(db, { bookingId: Number(c.req.param('id')), userId: user.id });
      await mailer.send({ to: user.email, ...templates.cancellation(user, await getSlot(db, b.slot_id)) });
      return c.redirect('/me');
    } catch (e) { if (e instanceof BookingError) return c.notFound(); throw e; }
  });
  // JSON for the mobile app
  r.get('/api/slots', async (c) => c.json(await openSlots(c.var.db, c.var.now())));
  return r;
}
