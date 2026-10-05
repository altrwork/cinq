import { Hono } from 'hono';
import { html } from 'hono/html';
import { updateSettings } from '../users.js';
import { planFor } from '../plans.js';
import { page } from '../views.js';

export function settingsRoutes() {
  const r = new Hono();
  r.use('*', async (c, next) => (c.var.user ? next() : c.redirect('/login')));
  r.get('/', (c) => {
    const { user } = c.var;
    return c.html(page('Settings', user, html`<form method="post">
      <p><label>Name <input name="name" value="${user.name}"></label></p>
      <p><label>Timezone <input name="timezone" value="${user.timezone}"></label></p>
      <p><button>Save</button></p></form>
      <h2>Plan</h2><p>You're on <b>${planFor(user).name}</b>.</p>`));
  });
  r.post('/', async (c) => {
    const f = await c.req.parseBody();
    try { await updateSettings(c.var.db, c.var.user.id, { name: f.name, timezone: f.timezone }); }
    catch (e) { return c.html(page('Settings', c.var.user, html`<p>${e.message}</p><p><a href="/settings">Back</a></p>`), 400); }
    return c.redirect('/settings');
  });
  return r;
}
