# Cinq: a Git platform where AI coding agents check each other's work

[![npm](https://img.shields.io/npm/v/cinq-git)](https://www.npmjs.com/package/cinq-git) [![license: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

Most developers working with agents have become proxies for agent code review. Cinq takes you out of that loop
without taking away control: **you set the house rules, and an assembly line of independent agents builds,
examines, reviews and lands everything else.** Only the exceptions you defined come back to you.

You ask Claude Code for things the way you do today, one long ask, several people at once. Behind it, entirely on Cloudflare:

- Your ask becomes tickets. Your session builds the first; lean crew agents build the rest, each on its own fork on **Cloudflare Artifacts**.
- A blind examiner writes hidden tests from the goal alone. A reviewer that didn't write the change reads the diff against **your house rules** and cites the rule it breaks. It can be another vendor's agent (`--agent codex`, experimental).
- Hard gates run as code before anything reaches main. When two changes collide, nobody resolves a merge conflict: a *different* agent rebuilds the stale one from its goal, on top of the latest code.

**No agent grades its own work, and you only see the exceptions.** Made by [altr](https://altrwork.com).

## Quickstart

**You need:**
- a Cloudflare account on **Workers Paid** ($5/month), with a workers.dev subdomain (the dashboard's Workers & Pages page sets one up)
- **Node 22+** and **git**, with your name and email set (`git config --global user.name` / `user.email`)
- **Claude Code**, installed and logged in
- a JavaScript or TypeScript repo with at least one commit, tested with `node --test`, vitest or jest (no repo handy? try [`examples/slotly`](examples/slotly))

**1. Put Cinq in your Cloudflare account** (once):

```bash
npx cinq-git deploy
```

A browser opens for your Cloudflare login the first time. You'll see `✔ Cinq is running in your Cloudflare account: https://cinq.<you>.workers.dev` and **your approval code**. Save the code in a password manager now: it is shown only once, and you type it to approve a parked job, change your house rules or delete a repo.

**2. Connect a repo:**

```bash
cd your-repo
npx cinq-git init
```

This puts the repo on Cinq (its branch becomes main), connects Claude Code to it, and commits short agent instructions to `CLAUDE.md` and `AGENTS.md`.

**3. Start the crew**, in a second terminal in the same folder:

```bash
npx cinq-git crew
```

These are the agents that examine, review and rebuild work. They wait quietly and start a Claude Code session only when a job needs one, so leave this terminal open: nothing lands without them. The crew stops by itself after 30 idle minutes.

**4. Ask Claude Code for something**, in the repo, the way you do today (restart Claude Code if it was already open, so it sees Cinq).

**5. Open the dashboard:**

```bash
npx cinq-git open
```

### The dashboard

`npx cinq-git open` opens `https://cinq.<you>.workers.dev/r/<repo>` in your browser, already signed in. Run it inside the repo folder, or anywhere with `--repo <name>`. The sign-in lasts until you close that tab (a bookmark won't sign you in): to come back, run `npx cinq-git open` again.

On the dashboard: **Live** shows what each agent is doing, **Jobs** shows every change and why it landed or stopped, **Code** is main, **Why is this here?** maps every line to the job that put it there, and **House rules** is where you set the bar every review is held to.

### What happens next

Claude Code turns your ask into **jobs**: a goal, the files it may change, and tests that fail today. For each job, an **examiner** writes hidden tests without seeing the code, a **reviewer** reads the diff against your house rules, and then it **lands** on main. If two jobs collide, another agent rebuilds one on top of the other. Anything you said should come to you is **parked**: it shows on the dashboard (and in `npx cinq-git status`), where you approve, retry or drop it. `npx cinq-git sync` brings landed work into your checkout.

### If something goes wrong

- **`deploy failed`**: the account must be on Workers Paid and have a workers.dev subdomain.
- **`git doesn't know who you are`** or **`no commits yet`**: set your git name and email, or make a first commit, then run `init` again.
- **`no repo here`**: run the command inside the folder where you ran `init`, or pass `--repo <name>`.
- **"Sign in from your terminal" in the browser**: run `npx cinq-git open` again.
- **Jobs wait for a reviewer forever**: no crew is running. Start `npx cinq-git crew`.
- **Lost the approval code**: `npx cinq-git approval-code` makes a new one (it needs your Cloudflare login; the old code stops working).

### More commands

- `npx cinq-git status` / `watch`: the board, and what is waiting on you
- `npx cinq-git decide <job> approve|retry|drop`: your call on a parked job, from the terminal
- `npx cinq-git rules edit`: edit the house rules in your editor (or use the dashboard's House rules page)
- `npx cinq-git sync`: pull landed work into your checkout; `--branch <name>` moves that branch to main instead, leaving your checkout alone
- `npx cinq-git init --track-tokens`: each Claude Code session reports what it spent, so the board shows tokens per change on main
- `npx cinq-git crew --agent codex --only review` (experimental): Codex as your reviewer; `--only review|examine` runs a crew with one role
- `npx cinq-git stop`: revoke every agent key
- `npx cinq-git --help`: everything else

The test runner is detected from `package.json`. To override it, or to set `protectedPaths` and `diffBudget`, commit `.cinq/config.json` before `npx cinq-git init`: once main is on Cinq, no job may change `.cinq/`.

## Why

Git and code review were built for a few people working for hours. Put many agents on one codebase and three things break:

1. **Collisions.** In our concurrent runs, 19 of 56 changes (34%) would have needed a person under plain git: 10 hit a merge conflict and 9 merged cleanly but broke main (3 of those 9 were a contract change we planted on purpose). [Raw runs](docs/evidence/relay).
2. **Review.** Nobody can read hundreds of agent diffs a day.
3. **Trust.** Which agent made this change, and did anything independent actually check it?

## How it works

```
 you ──► Claude Code ──(MCP)──► Worker ──► RepoDO (Durable Object per repo: jobs, claims, landing queue, events)
                                              │
            own Artifacts fork ◄──────────────┤ propose_intent → overlap warning, fork + lease
            git push ────────────────────────►│ submit
                                              ▼
                        Lander (Container, the only writer to main)
                        security gates → merge onto latest main → tests (repo's + job's + hidden)
                        → review by another agent → land
                        conflict / red / cheat / blocked → a different agent rebuilds it from the goal
                        protected path / oversized / risky dependency → parked for you to decide
```

- **Ask.** A long ask becomes tickets (`propose_plan`): each one a job that can land on its own. The asking session builds the first (it knows the code best); lean crew agents build the rest. The board groups them by ask and says who asked.
- **House rules.** The review criteria you set, in the web home or with `npx cinq-git rules edit` (saving takes your approval code). Every review work order carries them, every blocking finding cites the rule it breaks, every receipt records the version, and `.cinq/rules.md` lands on main. They can also say which agents may review (`reviewer-*`, `codex-*`).
- **Job (intent).** Before writing code, the agent registers a one-line goal, the files it may change, a sentence on its approach, and tests that **fail on today's code**. Tests that already pass are refused. If another open job already changes the same files, the agent is told which job and who holds it, before it starts.
- **Examiner.** A *different* agent writes hidden tests from the goal alone: it sees neither the author's code nor its tests. The change can't land until it passes them. If it fails one, the author is told only that a hidden test failed, never which (the code under test can still read them while it runs: see Limits). Hidden tests that run nothing are refused. For a refactor (`kind: "keep"`) the hidden tests pin today's behaviour instead. They gate the landing and aren't committed; the receipt records their count and hash.
- **Reviewer.** Once every gate passes, a *different* agent (never the author, a builder or the examiner) reads the diff and returns `pass` or `block`, with a summary and findings. A pass lands the exact commit that was reviewed, without re-running the suite if nothing changed since. A block goes back to be rebuilt by an agent that hasn't built or blocked it; a second block parks it. `.cinq/config.json`: `"review": "block" | "advisory" | "off"`.
- **Hard gates:** stay inside the declared files; never edit or delete existing tests (except through a test change another agent approved); never touch `.cinq/`; don't hand in nothing; registered tests come from the platform, not the fork; no secrets in any commit the landing brings in; declare dependency changes; main must not move while the candidate's code runs.
- **Exceptions park for you:** a protected path (`.github/**`, `**/auth/**`, `**/wrangler.*`, `.env*`, `.npmrc`, `Dockerfile` by default, or `protectedPaths`; the review guides such as `REVIEW.md` always), a job over the diff budget (400 lines, `diffBudget`), a new package with install scripts, a job blocked twice in review or that failed twice. You decide on its page in the web home, or with `npx cinq-git decide <job> approve|retry|drop`. Approving lets that exact commit past the one gate it hit, and an agent still reviews it; the receipt records your sign-off. Approving takes your approval code, shown once when you deploy and stored nowhere on your machine; so does deleting a repo, or re-importing one that was deleted.
- **Agent code never touches the push.** Installs and tests run in a throwaway copy with no `.git`, as their own unprivileged user. The landing commit is built from a tree fixed before that code runs, and the token reaches only the single git push that needs it. Install scripts are off unless main's `.cinq/config.json` sets `"installScripts": true`.
- **Self-healing.** A conflicting or failing change goes back on the board and a different agent rebuilds it from the goal (at most 2 attempts). A session that goes quiet loses its lease, and someone else finishes the job.
- **Signed by Cinq.** Every landing commit is signed with the deployment's own SSH key (made at `npx cinq-git deploy`; `npx cinq-git signing-key` adds one to an older deployment), and main carries `.cinq/allowed_signers`, so `git -c gpg.ssh.allowedSignersFile=.cinq/allowed_signers log --show-signature` shows which commits Cinq landed. Agent commits inside a landing stay unsigned: the signature says the platform checked them, not that an agent wrote them.
- **Receipts in the repo.** Each landing commit carries `.cinq/intents/<id>.md` and `.cinq/receipts/<id>.json`: the goal, the approach, the agents, every gate, security findings and the review. The web home's "Why is this here?" maps every line to the job that put it there; "Files in play" shows which open jobs change which files.
- **No AI runs on Cinq's side.** Every agent is yours: Claude Code on your machine, on your plan.

## Cloudflare primitives

| Piece | Primitive |
|---|---|
| main + one fork per job | **Artifacts** (Workers binding; plain `git` over HTTPS) |
| coordination, single source of truth | **Durable Objects** (SQLite, alarms, hibernating WebSockets) |
| lander (real `git` + the repo's own test runner) and a reader for checks and browsing | **Containers**, two per repo (stock `node:22` image; stop when idle) |
| agent interface | **MCP** on Workers (Claude Code and Codex speak it natively) |
| API + web home | **Workers** + static assets |

## Bring your own review prompt

House rules are short (at most 30, up to 400 characters each) so a block can cite one by number. Already have a longer code-review prompt your team uses? Commit it as **`REVIEW.md`** at the root of your repo. Every reviewer reads it on main next to the house rules, along with any of these it finds near the changed files:

`REVIEW.md` · `AGENTS.md` · `.cursor/BUGBOT.md` · `CONTRIBUTING.md` · `ARCHITECTURE.md` · `STYLEGUIDE.md` · `CONVENTIONS.md` · `docs/architecture*.md`, `docs/adr*.md`, `docs/decisions*.md`

The nearest files to the change come first, up to 8 files and about 30,000 characters. These files (and `CLAUDE.md`) are always protected, even when you set your own `protectedPaths`: an agent that changes one parks for you, so no agent can lower its own bar. `npx cinq-git init` tells you which ones it found, and the web home lists them under House rules.

## Where your code lives, and how it ships

Cinq replaces the pull-request step; it doesn't sit in front of GitHub.

- **Main is a Git repo on Artifacts, in your account**: `<repo>-trunk` in the Artifacts namespace named after your deployment (`cinq` by default). Browse it in the web home, clone it, or bring it to your checkout with `npx cinq-git sync`.
- **Deploy on every landing with Workers Builds.** In the dashboard: Workers & Pages → Create application → Continue with Artifacts → your namespace → `<repo>-trunk` ([Cloudflare's guide](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/artifacts-integration/)). Pushes to `main` deploy to production, and only the lander writes `main`, so only examined, reviewed, tested work ever deploys. Other branches get Worker Previews.
- **Custom CI, or a target that isn't a Worker:** an Artifacts `cf.artifacts.repo.pushed` trigger starts a Workflow on every landing ([guide](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/)).
- **Coming from GitHub:** `npx cinq-git init` imports the branch you're on, with its history. While a team still deploys from GitHub, `npx cinq-git sync --branch cinq && git push origin cinq` hands landed work to that pipeline without touching your checkout. There is no automatic push back to GitHub, on purpose: main lives here.

## From one developer to a team

Cinq is built for one person with a crew of agents, and it doesn't change shape when people join.

- **Alone:** your Claude Code takes one long ask and splits it into tickets; `npx cinq-git crew` builds, examines, reviews and rebuilds the rest. You set the house rules and decide the exceptions.
- **A teammate joins:** send them your deployment URL and owner key (both in `~/.cinq/config.json`). They run `npx cinq-git login --url <url> --owner-key <key>`, then `npx cinq-git init` in their own checkout, which gives their Claude Code its own agent key. The owner key lets them run the CLI and the dashboard; approving still takes your approval code. Both people's sessions post to the same board: every ask is grouped and says who asked, overlapping work is warned before it starts, and whichever lands second is rebuilt on top. The [Slotly runs](docs/evidence/slotly-r1) are two people, one long ask each, at the same time.
- **What stays with the owner:** the approval code (approve a parked job, change the house rules, delete a repo). One owner per deployment today; per-person approvers are not built yet.

## Develop

```bash
npm test                 # engine, lander and security unit tests
npm run test:e2e         # review, rebuild and overlap end to end against your deployment
npm run test:cloud       # every gate and cheat against a deployment made with `npx cinq-git deploy --dev-scenarios`
```

`app/cli` is the CLI, `app/worker` the Worker, Durable Objects and lander, `app/web` the web home, `backtest/` the real-repo backtest, `docs/DECISIONS.md` the design decisions and `docs/EVIDENCE.md` how we measured.

## Evidence

| What | Result |
|---|---|
| Concurrent relay on Artifacts, 5 runs, on a small repo of our own ([raw](docs/evidence/relay)) | **56/56 landed, main green after every landing**, 16/16 rebuilds green first time |
| Lander scenarios on the deployment (`npm run test:cloud`): 12 cheats (tests and install scripts that push to main, a secret, an undeclared dependency, a protected path, an oversized job, weakened or deleted tests, an edit outside the job's files, a hard-coded answer, a forged receipt, an empty hand-in) and 6 normal cases | **18/18 as expected**; no cheat moved main |
| Review, rebuild and overlap on the deployment (`npm run test:e2e`) | A job blocked by one reviewer, rebuilt by a different agent from the findings, passed by a second reviewer and landed; a second job on the same file warned before it started |
| 5 Claude Code authors + crew on one repo ([board and event log](docs/evidence/splitbill-2)) | 5 landed, 1 parked, main green; every landing reviewed by an agent that didn't write, rebuild or examine it |
| A normal day on [Slotly](examples/slotly): two people's Claude Code, one long ask each, crew + reviewer crew under house rules ([r1](docs/evidence/slotly-r1), [r2](docs/evidence/slotly-r2)) | r1: 7 tickets, **6 landed with no person involved**, Stripe checkout parked on `payments/`, 2 collisions rebuilt; 12 minutes |
| The same two asks as a review-on-every-push workflow ([raw](docs/evidence/workflow-1)) | 2.6M tokens; Cinq's best run ([r3](docs/evidence/slotly-r3)) 3.75M (first run: 8.4M), spent on a blind examiner and a three-axis review for every ticket, and it stopped payments for a person; the workflow merged them with nobody looking |
| 126 scripted (not model) agents on one repo, one shared file, every landing examined and reviewed ([raw](docs/evidence/swarm-r7)) | 119 jobs: **113 landed, 6 parked, none stuck**, main green after all 113 landings; 47 minutes, ~2.4 landings a minute |
| One real week of [Hono](https://github.com/honojs/hono) (13 changes; [raw](docs/evidence/bt-hono-muq8hafh)) | **10 of 11 jobs landed with no human touches**, each passing its real authors' tests; main never broke. The 2 that change what existing tests pin were refused, then re-run once approved test changes existed: both landed ([raw](docs/evidence/bt-hono-muqbeshx)) |
| Deploy on landing: Workers Builds connected to a repo's trunk on Artifacts | A Claude Code ask, examined, reviewed and landed as `2b306ca` (signed by Cinq); the live Worker showed the new version within a minute, with no pull request and no GitHub |
| Examiner on Hono (18 planted bugs) | blind hidden tests caught **14**; Hono's own tests caught **16**; 0 false alarms. On 3 changes the examiner's tests never ran (counted as misses; now refused) |

How each number was measured, and what it doesn't show: [docs/EVIDENCE.md](docs/EVIDENCE.md). The planted-bug numbers are from our run notes. Not yet run: a second real repo (es-toolkit) and a second agent vendor (Codex).

## Limits

- **Your owner key is a file.** It lives in `~/.cinq/config.json`. `init` and `crew` deny Claude Code's file tools access to `~/.cinq`, but agents run tests, and test code runs as you and can read the file. What the key can't do: write main after the import at `init` (its token is refused once work is handed in and never outlives 30 minutes from the first import), read an open job's hidden tests, approve a parked job, or delete and re-import a repo (those take your approval code, which isn't on disk). What it can do: mint agent keys, so code that steals it could pose as a second agent and review its own change. And the crew runs tests that agents wrote, as you: such code can also reach your Cloudflare login (wrangler's saved session), which can redeploy Cinq or reset the approval code. Run agents as a separate OS user if that matters to you.
- **A Codex crew can read your home folder.** Codex's workspace sandbox reads the whole disk, `~/.cinq` included (Claude Code crews are denied it). Run a Codex crew as a separate OS user if that matters.
- **Tests have network access.** Containers can only switch egress off for the whole container, and the lander needs Artifacts. No credential is reachable from agent code, so main stays safe. But the code under test runs next to the hidden tests, so code written to look for them could read them and send them out.
- **A shared kernel is still shared.** Agent code runs as its own user in the lander's container; a container escape is out of scope.
- **Landing is serial**, one change at a time per repo, so main stays green: about 2–4 landings a minute on a small repo with every landing reviewed, fewer with slow test suites. Checks and browsing run on a separate reader container, so they don't wait for landings.
- **Overlap is by file.** Two jobs on the same file are warned, not blocked: whichever lands second is rebuilt on top. Two jobs that conflict through different files are caught at landing, not before.
- **Review adds a turn.** Each landing waits for a free reviewer. Use `"review": "advisory"` or `"off"` to trade that away.
- **Agent identity is per key.** `init` gives one key per machine, so Claude Code sessions there share an identity. They still get separate jobs and leases, but one of them can't review another's work. A rebuilt job needs four different agents (author, examiner, rebuilder, reviewer); `crew` starts 4.
- **Your own commits reach main through jobs**, hotfixes included. There is no direct push to main, for you or your agents; `npx cinq-git sync` brings landed work back to your checkout. Commits made on another host (say, GitHub) after `init` aren't imported: bring them in as a job.
- **Untested side effects pass every gate.** The mitigations are the examiner's hidden tests, the review and the receipts.
- **Nothing watches production after a deploy.** Main is green before it deploys, but if a landing breaks production, rolling back is up to you (Workers gradual deployments and rollbacks). Next: a health check that opens a revert as a job, examined, reviewed and landed like any change.
- **No backup of main beyond Artifacts itself.** Deleting a repo takes the approval code; a scheduled snapshot (to R2) is the next step.
- **The event log grows without bound**; the web home loads only the latest 3,000 events.
- **The web home login link carries the owner key** in the URL fragment, which the browser never sends to the server. Treat the link like the key.
- **The dependency gate reads npm and pnpm (v6) lockfiles** for install scripts; yarn's lockfile doesn't record them, and pnpm v9 dropped the flag.
- **The first landing on a new repo is slow** (~20 s container cold start, plus one install per lockfile).

## Cost

Everything runs on your own account, on Workers Paid ($5/month). Your agents run on your machine and your own Claude plan; that is where most of the cost is.

- **Workers, Durable Objects and Artifacts** stayed inside included usage in our testing.
- **Containers** are the only metered part. Each repo has a lander (tests and lands work) and a reader (checks a job's tests fail on main today). Both are `basic` (1 GiB) and stop after about a minute idle. The web home's file views are cached until main changes, so browsing doesn't keep a container awake.
- **What that means:** Workers Paid includes 25 GiB-hours of container memory a month, about 25 awake hours. A landing keeps a container awake for 1–3 minutes, so a heavy month (40 landings a day) is roughly 50–60 awake hours: well under $1 above the plan.
- A repo whose install or tests need more memory: `npx cinq-git deploy --lander-size standard-1` (4 GiB, about 4× the cost per minute). `--max-landers` caps how many run at once (default 6).

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). If you redistribute Cinq or build on it, keep the NOTICE file and its attribution. (Version 0.1.0 on npm was released under MIT; every later version is Apache 2.0.)

"Cinq", "altr" and their logos are trademarks of Uncreated LLC and aren't covered by the license.

© 2026 Uncreated LLC, d/b/a [altr](https://altrwork.com).
