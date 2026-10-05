import { Hono } from 'hono';
import { html } from 'hono/html';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { findByEmail } from '../users.js';
import { createSession, endSession } from './session.js';
import { page } from '../views.js';

// Sign in by email. In production the session link is emailed; signInDirect (local dev and tests) signs in at once.
export function authRoutes({ signInDirect = false } = {}) {
  const r = new Hono();
  r.get('/login', (c) => c.html(page('Sign in', null, html`<form method="post"><input name="email" type="email" placeholder="you@example.com"> <button>Send me a link</button></form>`)));
  r.post('/login', async (c) => {
    const { db, mailer, now } = c.var;
    const { email } = await c.req.parseBody();
    const user = await findByEmail(db, email || '');
    if (user) {
      const token = await createSession(db, user.id, now());
      if (signInDirect) { setCookie(c, 'session', token, { httpOnly: true, sameSite: 'Lax', path: '/' }); return c.redirect('/'); }
      await mailer.send({ to: user.email, subject: 'Your Slotly sign-in link', text: `Sign in: ${new URL(c.req.url).origin}/login/${token}` });
    }
    return c.html(page('Check your email', null, html`<p>If ${email} has an account, a sign-in link is on its way.</p>`));
  });
  r.get('/login/:token', (c) => { setCookie(c, 'session', c.req.param('token'), { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' }); return c.redirect('/'); });
  r.post('/logout', async (c) => { await endSession(c.var.db, getCookie(c, 'session')); deleteCookie(c, 'session', { path: '/' }); return c.redirect('/'); });
  return r;
}
