import { run } from './db.js';
import { formatWhen } from './time.js';

// Email goes through a provider (Resend, Postmark, ...) injected by the Worker; every send is logged.
// provider.send({to, subject, text}) resolves on success and throws on failure.
export function createMailer(db, provider, now = () => Date.now()) {
  return {
    async send({ to, subject, text }) {
      await provider.send({ to, subject, text });
      await run(db, 'INSERT INTO emails (to_addr, subject, body, sent_at) VALUES (?, ?, ?, ?)', to, subject, text, now());
    },
  };
}

export const templates = {
  confirmation: (user, slot) => ({
    subject: `Booked: ${slot.title}`,
    text: `Hi ${user.name},\n\nYou're booked for ${slot.title} on ${formatWhen(slot.starts_at, user.timezone)}.\n\nSee you then,\nSlotly`,
  }),
  cancellation: (user, slot) => ({
    subject: `Cancelled: ${slot.title}`,
    text: `Hi ${user.name},\n\nYour booking for ${slot.title} on ${formatWhen(slot.starts_at, user.timezone)} is cancelled.\n\nSlotly`,
  }),
};
