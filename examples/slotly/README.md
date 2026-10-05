# Slotly

A small booking app on Cloudflare Workers + D1 (Hono): businesses publish times, customers book them, everyone
gets an email. It is the example repo for trying [Cinq](../../README.md).

## Try Cinq on it

Copy this folder into its own git repo, then follow the main README's quickstart from step 2:

```bash
git clone https://github.com/altrwork/cinq.git
cp -r cinq/examples/slotly ~/slotly && cd ~/slotly
git init && git add -A && git commit -m "Slotly"
npx cinq-git init              # after npx cinq-git deploy, once
npx cinq-git crew              # in a second terminal, same folder
```

Then ask Claude Code for one of the known gaps (good first asks):

- two people can book the same slot at the same moment
- there are no reminders before a booking
- admins can't export bookings
- there is no way to pay for Pro

`.cinq/config.json` adds `payments/` to the protected paths, so anything that takes money waits for you, and
`AGENTS.md` holds the conventions every review is held to.

## Run the app itself (optional, not needed for Cinq)

```bash
npm install && npm test        # the suite runs on Node's own test runner against an in-memory database
npx wrangler d1 create slotly  # then put its id in wrangler.jsonc, and: npm run db:init && npm run dev
```
