import { html, raw } from 'hono/html';
import { formatWhen } from './time.js';
import { formatCents } from './money.js';

export const page = (title, user, body) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Slotly</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1b1b1b}a{color:#2459c6}
nav{display:flex;gap:16px;margin-bottom:24px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eee}
.muted{color:#777}button{font:inherit;padding:6px 12px}</style></head>
<body><nav><b>Slotly</b><a href="/">Book</a>${user ? html`<a href="/me">My bookings</a><a href="/settings">Settings</a>${user.role === 'admin' ? html`<a href="/admin">Admin</a>` : ''}` : html`<a href="/login">Sign in</a>`}</nav>
<h1>${title}</h1>${body}</body></html>`;

export const slotRow = (slot, user) => html`<tr><td>${formatWhen(slot.starts_at, user?.timezone)}</td><td>${slot.title}</td>
  <td>${slot.price_cents ? formatCents(slot.price_cents) : 'Free'}</td>
  <td>${user ? html`<form method="post" action="/book/${slot.id}"><button>Book</button></form>` : html`<a href="/login">Sign in to book</a>`}</td></tr>`;

export const bookingRow = (b, user) => html`<tr><td>${formatWhen(b.starts_at, user.timezone)}</td><td>${b.title}</td>
  <td><form method="post" action="/cancel/${b.id}"><button>Cancel</button></form></td></tr>`;

export const empty = (text) => html`<p class="muted">${text}</p>`;
export { raw };
