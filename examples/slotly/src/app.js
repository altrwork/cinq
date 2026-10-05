import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { userForToken } from './auth/session.js';
import { createMailer } from './email.js';
import { publicRoutes } from './routes/public.js';
import { settingsRoutes } from './routes/settings.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './auth/routes.js';

// The app takes its dependencies, so tests run it against an in-memory database and a fake mail provider.
export function createApp({ db, mailProvider, now = () => Date.now(), signInDirect = false }) {
  const app = new Hono();
  const mailer = createMailer(db, mailProvider, now);
  app.use('*', async (c, next) => {
    c.set('db', db); c.set('mailer', mailer); c.set('now', now);
    c.set('user', await userForToken(db, getCookie(c, 'session'), now()));
    await next();
  });
  app.route('/', authRoutes({ signInDirect }));
  app.route('/', publicRoutes());
  app.route('/settings', settingsRoutes());
  app.route('/admin', adminRoutes());
  app.onError((e, c) => { console.error(e); return c.text('Something went wrong', 500); });
  return app;
}
