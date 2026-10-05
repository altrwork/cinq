import { createApp } from './app.js';

// Mail goes through Resend in production; without a key, mail is logged and dropped.
const resend = (env) => ({
  async send({ to, subject, text }) {
    if (!env.RESEND_API_KEY) return console.log(`[mail] to ${to}: ${subject}`);
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'Slotly <hello@slotly.app>', to, subject, text }) });
    if (!r.ok) throw new Error(`mail provider answered ${r.status}`);
  },
});

export default {
  fetch: (req, env, ctx) => createApp({ db: env.DB, mailProvider: resend(env), signInDirect: env.DEV_LOGIN === '1' }).fetch(req, env, ctx),
  async scheduled() {}, // every 15 minutes (wrangler.jsonc); nothing scheduled yet
};
