# Contributing

Thanks for looking at Cinq. A few things keep changes easy to review:

- **Open an issue first** for anything bigger than a small fix, so we can agree on the approach.
- **`npm test` must pass** (engine, lander and security unit tests; Node 22+ and git, no install needed). If you
  change how landing works, also run `npm run test:e2e` against your own deployment (`npx cinq-git deploy`).
- **Keep it lean:** no new dependency without a reason in the PR, no abstraction with one caller, comments that say
  why rather than what.
- **License:** contributions are accepted under the Apache License 2.0, the project's license.
- **Security issues** go privately: see [SECURITY.md](SECURITY.md).

Where things live: `app/cli` is the CLI, `app/worker` the Worker, Durable Objects and lander, `app/web` the dashboard,
`docs/DECISIONS.md` the design decisions and `docs/EVIDENCE.md` how the numbers in the README were measured.
