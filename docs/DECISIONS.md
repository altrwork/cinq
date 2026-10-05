# Design decisions

Each entry: what was decided, what lost, and what would reverse it.

## 1. Ship the intent, not the diff
The unit of change is a **job (intent)**: a goal, the files it may change, and tests that fail on today's code. The diff is disposable. When main moves under a change, or a change breaks a job that already landed, a *different* agent rebuilds it from its goal on a fresh fork, and it lands only if every gate passes.
- **Overlap is warned, not locked.** A job whose files another open job already changes gets the list at registration; the agent narrows its files, picks other work, or goes ahead and whichever lands second is rebuilt. Locking files would serialize exactly the work that usually merges cleanly.
- **Lost:** leases plus a merge queue plus receipts (all prior art; leases are pessimistic locking); speculative trunks on forks (also prior art).
- **Not built:** proactive invalidation when a contract changes. Only the reactive path exists: a landing that breaks an already-landed job's tests returns `breaks-dependents`, and that job is rebuilt on top. A change that breaks more than one landed job parks.

## 2. One Durable Object per repo, one lander per repo
`RepoDO` is the single source of truth: jobs, claims and leases, the landing queue, the event log and hidden tests. It drives landings with alarms (one landing per alarm) and streams events over hibernating WebSockets. The lander is a Container with real `git` and the repo's own test runner, and it is the only writer to main. A second container per repo, the reader, runs the tests-fail-today check and browsing, so agents and the web home never wait behind a landing. Receipts and intents live in the repo under `.cinq/`.
- **Lost:** Workflows and Queues as a second source of truth; Dynamic Workers for tests (no real git or npm); a mutation gate (the examiner's hidden tests and the diff review cover it).
- **Flaky tests:** each failing file gets one re-run; a pass is reported as flaky on the receipt. Infrastructure failures retry without counting against the change.
- **Reverse if:** the lander can't keep up (landing is serial: ~2–4 a minute on a small repo with every landing reviewed).

## 3. Agents regulate themselves
Agents register jobs themselves from your normal request (instructions installed by `npx cinq-git init`). Trust comes from separation of duties, not human approval: the author never has the final say, an examiner writes hidden tests from the goal alone, and a reviewer reads the diff. You're contacted only for exceptions.
- **Lost:** human approval of every job (it interrupts the agent's flow and adds little).
- **Reverse if:** examiner-written hidden tests catch materially fewer bad changes than human-written ones. Measured on Hono: 14 of 18 planted bugs vs 16 for the maintainers' own tests, 0 false alarms.

## 4. Artifacts is the system of record
Landing on main is final; there is no second approval elsewhere. `npx cinq-git init` imports a repo once and `npx cinq-git sync` pulls main back.
- **Not built:** importing direct pushes to GitHub through the same gates (the GitHub mirror: see 9).

## 5. Agent code never touches the push
The trunk token is never written where agent code runs: `origin` has no credentials, and the token reaches git only as an `http.extraHeader` in the environment of the one fetch, `ls-remote` or push that needs it. Installs and tests run in a throwaway copy with no `.git`, as their own unprivileged user. The landing commit is built with `commit-tree` from a tree fixed before agent code runs, and the lander refuses to land if its git config changed. Every agent-named path is a plain path inside the repo, and ids are slugs. Install scripts are off unless main's `.cinq/config.json` opts in.
- **Lost:** a separate container for tests (a second cold start per landing).
- **Not done:** network isolation for tests (Containers switch egress off only for the whole container, and the lander needs Artifacts).
- **Reverse if:** a cheat in `security.test.mjs` or the cloud scenarios reaches main.

## 6. Deterministic security gates; exceptions park
Before any candidate code runs: `secrets` (token formats plus entropy) refuses; undeclared dependency changes refuse; a new package with install scripts, a `protectedPaths` hit or a job over `diffBudget` (400 lines) parks for a person, since rebuilding would hit the same gate.
- **Lost:** Semgrep/CodeQL in the lander (a heavy image, minutes per landing).
- **Reverse if:** entropy false positives make agents strip legitimate fixtures (then report-only).

## 7. A reviewer agent reads every diff
After every gate passes, the job waits for a `review` work order claimed by your own agents. The reviewer is never the author, a builder or the examiner, sees the goal, the diff and every gate result, and returns `{verdict, findings}`. A pass lands the exact reviewed commit; a block is rebuilt with the findings; two blocks park. `review`: `block` (default) | `advisory` | `off`.
- The reviewer can only add a block; it never overrides a deterministic gate.
- **Reverse if:** reviewers block correct changes often enough that the park rate climbs (then default to `advisory`).

## 8. A person decides parked jobs, one commit at a time
A parked job waits for its owner: approve, retry with a note, or drop (web home or `npx cinq-git decide`). Approval waves through only the security gate the job hit, only for the exact commit that hit it, and an agent still reviews it; the receipt records who approved what. A job parked for failing twice can only be retried or dropped.
- **Lost:** an override that lands without review (a person approving a gate is not a code review).
- **Approval code:** approving, changing the house rules, deleting a repo and re-importing a deleted one need a code shown once at deploy and stored only as a hash in the deployment, so an agent holding only the owner key can't approve its own parked change or rewrite main by deleting and re-importing it.
- **Owner key:** it can create a repo and import its history (until the first hand-in, at most 30 minutes), mint agent keys, retry or drop parked jobs. It cannot approve one, and it cannot read an open job's hidden tests.

## 9. Main lives in Cinq; deploys follow it, GitHub doesn't
Cinq's main on Artifacts is the trunk, not a staging step before GitHub. Deploys run from it: Workers Builds connected to `<repo>-trunk` deploys every landing (only the lander writes `main`), and an Artifacts push trigger starts a Workflow for custom CI. `npx cinq-git sync --branch <name>` hands landed work to an existing pipeline during a move, without touching the checkout.
- **Lost:** an automatic GitHub mirror. One was built and reverted the same day: it made Cinq read as a step in front of GitHub, and it needed a GitHub token stored as a deployment secret.
- **Lost:** importing commits made on another host after `init`. A hotfix comes in as a job, like any other change.
- **Reverse if:** teams can't adopt without GitHub staying the system of record (then bring the mirror back as opt-in, fast-forward only).

## 10. Landing commits are signed by the deployment
`npx cinq-git deploy` makes an ed25519 SSH key; the private half is a deployment secret (`LANDER_SIGNING_KEY`) and reaches the lander only in the landing call, where it is written to a root-only temporary folder for the one `git commit-tree -S` and removed. Main carries `.cinq/allowed_signers` (principal `lander@cinq.local`). Once signing is on, a landing that can't be signed is an error, never an unsigned landing.
- **Why:** receipts in the repo are only as good as your trust that nobody forged one later; a signature only the platform can make closes that.
- **Lost:** agents' own commits stay unsigned, so the signature attests "Cinq checked and landed this", not who typed it.
- **Reverse if:** a host the user deploys from can't verify SSH signatures (then keep receipts unsigned and say so).
