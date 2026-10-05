# Evidence

What we measured, how, and what it does not show. Where the raw output was kept, it is in [`evidence/`](evidence); where it wasn't, the number is marked as coming from our run notes. Each run folder has a `summary.json` (landed, parked, rebuilt, tokens and minutes where recorded, plus the run's own summary) and its raw output gzipped (`*.gz`; read with `zcat` or `gunzip -k`). Every run can be repeated against your own deployment with the harnesses in `backtest/`, `app/scripts/swarm.mjs` and `app/worker/test/`.

## Concurrent relay on Artifacts (5 runs, 56 changes) · [raw](evidence/relay)
4 to 10 Claude Code authors at once on one small JavaScript repo, each change written against a stale main. Each run's `.log.gz` is its console output; its `.receipts.json.gz` has the run summary and every change's receipt.
- **Result:** 56/56 landed. Every landing ran the full suite and main was green after each one. Each run then re-cloned main from Artifacts and ran the suite again (`verifiedFromArtifacts` in the summary). All 16 rebuilds went green on the first try.
- **The plain-git comparison:** for every change, the harness also merged the author's branch onto the same main with plain `git merge` and ran the suite. 37 merged cleanly and stayed green; 10 hit a textual conflict; 9 merged cleanly but broke main (`plain-git=` on each line of the logs). So 19 of 56 (34%) would have needed a person. 3 of the 9 are the `tax-percent` contract change we planted in the three day-2 runs, to exercise the rebuild-to-fit path.
- **Caveats:** a repo and goals we wrote ourselves; one model; one vendor. The runs predate the reviewer and the overlap warning.

## Lander scenarios on the deployment (`npm run test:cloud`)
18 scenarios run against the deployed lander through `/dev/scenario`, each on a throwaway repo. 12 are cheats: tests and install scripts that try to push to main, a planted secret, an undeclared dependency, a protected path, an oversized job, weakened, edited or deleted tests, a forged receipt, a hard-coded answer, an empty hand-in. 6 are normal cases: correct changes landing (two runners), a red change with the failing file named, zero tests never counting as green, a stale collision, and a contract change that breaks a landed job.
- **Result:** 18/18 as expected, and no cheat moved main. A secret added in one commit and removed in the next is refused too (`security.test.mjs`).
- **Caveats:** these call the lander directly, so they test the gates, not separation of duties (the engine tests and `npm run test:e2e` cover that). They are the cheats we thought of.

## Review, rebuild and overlap (`npm run test:e2e`)
On the deployment, over the same HTTP API agents use: a job blocked by one reviewer is rebuilt by a different agent from the findings, passed by a second reviewer, and landed, with the author's approach and the reviewer's summary in the receipt. A second job on the same file is warned at registration, and the board names who holds the first.

## 5 Claude Code authors and a crew on one repo · [raw](evidence/splitbill-2)
The demo run: five headless Claude Code authors building features of a small expense-splitting app at once, and Claude Code crew agents examining, reviewing and rebuilding. `jobs.json.gz` is the final board and `events.json.gz` the full event log, exported from the deployment.
- **Result:** 5 landed and 1 parked (it failed the examiner's hidden tests twice), main green. Every landing was reviewed by an agent that didn't write, rebuild or examine it.
- **Caveats:** this run found two engine bugs, both fixed since and covered by tests. The same agent rebuilt `add-settleup` twice (seq 73 and 86); a rebuild now never goes to an agent that already built the job (`a rebuild never goes to an agent that already built the job`). Two agents held the same rebuild at once (seq 106 and 107), and both versions reached review; a claim now reserves the job before its fork is made (`two agents claiming the same rebuild at once: exactly one gets it`).

## One real week of Hono (13 merged pull requests) · [raw](evidence/bt-hono-muq8hafh), [re-run](evidence/bt-hono-muqbeshx)
Real Hono at the start of a week in August, pushed to Artifacts. 6 concurrent Claude Code authors, each given only one real pull request's title and description, plus 2 crew agents. Each folder has the final board (`jobs.json.gz`), the event log (`events.json.gz`) and every job's registered and hidden tests (`tests.json.gz`), exported from the deployment that ran it.
- **Result:** 11 of 13 became jobs; 10 of those 11 landed with no human touches (the 11th was already done by another change). Each landed change passed its real authors' own tests on our main. Main never broke.
- **The other 2** (#5255 and #5291) change behaviour that existing tests pin, so their authors refused to edit those tests. Once approved test changes (`supersedes`) existed, both were re-run (`bt-hono-muqbeshx`) and both landed: #5291 as written, with its change to an existing test approved by another agent; #5255 after two rebuilds. So all 13 ended on main or were already done, across two runs.
- **Caveats:** the re-run had only those 2 changes, not the whole week at once.

## Examiner on Hono (18 planted bugs) · run notes; the examiner's tests are in `tests.json.gz`
For the same changes, wrong versions of each fix were planted, then caught (or not) by the examiner's hidden tests, written from the goal alone, and by Hono's own tests.
- **Result:** the examiner caught 14, Hono's maintainers' tests 16, with 0 false alarms. Where the examiner's tests ran (7 changes, 15 bugs), the examiner caught 14 and Hono's tests 13.
- **Caveats:** on 3 changes the examiner's tests never ran in Hono's runner. They count as misses, and the platform now refuses hidden tests that run nothing.

## Scale: 126 scripted agents on one file · [raw](evidence/swarm-r7)
`app/scripts/swarm.mjs`: 126 scripted authors each register one job that adds an entry to the same array in the same file (40 anchor lines, so many really clash), and 12 scripted crew agents examine, review and rebuild. Every landing ran the full suite, hidden tests included, and was reviewed. `summary.json`, the board (`jobs.json.gz`), the event log (`events.json.gz`) and the console (`console.log.gz`) are in the folder.
- **Result:** 119 jobs were handed in (7 authors failed on the client's network before proposing). 113 landed and 6 parked after two failed rebuilds; none was left open. Main was green after all 113 landings (`trunk.head` events). 103 landings hit a conflict and went back to be rebuilt; 98 rebuilds. 47.5 minutes, about 2.4 landings a minute, median 18.7 minutes from registering to landing.
- **What the previous run found:** before this one, a job that passed review rejoined the back of the landing queue; behind ~90 others its reviewed commit went stale, so it conflicted, was rebuilt and reviewed again, and landings nearly stopped (33 in 18 minutes). A reviewed job now lands next. Covered by `a job that passed review lands next, ahead of the queue`.
- **Caveats:** these agents are scripts, not models: the run measures coordination and the landing queue, not agent judgement.

## A normal day on Slotly: two people, one long ask each · [r1](evidence/slotly-r1), [r2](evidence/slotly-r2)
`app/scripts/demo-day.mjs` on [`examples/slotly`](../examples/slotly), with real Claude Code. Two people's sessions (`maya`, `sam`), each in its own checkout, are given one long ask each at the same time (`app/scripts/demo-asks.mjs`). A crew of 4 Claude Code agents builds, examines and rebuilds; a reviewer-only crew of 2 reviews under three house rules (`reviewers: reviewer-*`). Every session's tokens are taken from Claude Code's own output and recorded on the board.
- **r1:** both sessions split their asks into tickets on their own (4 and 3). 6 of 7 landed with no person involved; Stripe checkout parked because it touches `payments/`. Two tickets collided at landing and were rebuilt by different agents. 12.3 minutes, 19 sessions, 8.4M tokens (99% cached reads), $5.87 at list prices.
- **r2** (after examiners got the files in their work order and authors stopped waiting for their landing): 5 landed; Stripe checkout parked on `payments/`, and the rename parked after three agents failed the test its planner registered (a person decides). 10.2 minutes, 15 sessions, 7.1M tokens, $5.74.
- **[r3](evidence/slotly-r3)** (lean crew sessions: one job each, a short role prompt, only that role's tools; three-axis reviews with the repo's guidelines and the code that uses the change in the work order; asks split into fewer, larger tickets): 6 tickets, 5 landed, Stripe checkout parked on `payments/`, one collision rebuilt. **6.7 minutes, 18 sessions, 3.75M tokens** (less than half of r1). A review now costs ~26k tokens (r1: ~110k) and an examination ~115k (r1: ~340k). The reviews raised real findings (an exported helper used in one file; a reminder that could be lost if the worker dies mid-send; a rename check that missed one file), at low severity, so all passed.
- **[r4](evidence/slotly-r4), an experiment we reverted:** the people's sessions only planned, and the crew built every ticket. Worse: 6.3M tokens, 4 landed, 2 parked. Plans written without building named the wrong files (refused at the footprint gate, then rebuilt), and a crew agent reused an old clone (fixed: a fresh folder per job). The asker builds the first ticket again, and builders now check their files before pushing.
- **[r5](evidence/slotly-r5)** (the r3 setup, plus builders checking their files before pushing): 5 landed, Stripe checkout parked on `payments/`, 7.7 minutes, 4.8M tokens. Run to run, the people's own sessions vary most (r3 1.7M, r5 2.3M); the crew's lean sessions held (reviews ~28k tokens each, examinations ~97k).
- **Caveats:** one app, one model, five runs; expect ±1M tokens between runs of the same day. The authors ran headless (`claude -p`).

## Against a review-on-every-push workflow · [raw](evidence/workflow-1)
`app/scripts/workflow-baseline.mjs`: the same two asks, the way most teams wire agents today. Each person's Claude Code builds the whole ask on a branch; on every push a fresh reviewer agent reads the whole diff against the same house rules; a block, red tests or a merge conflict starts a fresh fixer; it merges with plain git.
- **Result:** both pull requests merged and main was green. 6.3 minutes, 7 sessions, **2.6M tokens, $3.47**: a third of Cinq's first run, and about two thirds of Cinq's third (3.75M), which examined and reviewed each of 6 tickets.
- **What the difference buys:** Cinq examined and reviewed each of 7 tickets separately, with hidden tests the builder never saw, and stopped the payments change for a person. The workflow reviewed two large diffs (one review each, once it passed), wrote no independent tests, and merged Stripe checkout with no person looking.
- **So we don't claim Cinq is cheaper**, only that it has narrowed the gap (8.4M → 3.75M) while checking more. It spends more tokens, on independent checks. What it does guarantee: idle agents spend nothing (a crew session starts only with a job in hand), the gates are code and spend nothing, and every session's spend is on the board, by role.

## Deploy on landing, and signed landings (cinq-hello on cinq-demo, 2026-10-05)
A one-page Worker whose main lives on Cinq, with Workers Builds connected to its trunk repo in the dashboard (Workers & Pages → Builds → Artifacts; the Builds API does not accept Artifacts repositories yet). Two real asks in Claude Code, each registered, built on its own fork, examined blind, reviewed by a different agent and landed.
- **Result:** `2a6fc95` (0.2.0) and `2b306ca` (0.3.0) landed; `git log --show-signature` reports a good signature for `lander@cinq.local` on both. After `2b306ca` landed, the live Worker served 0.3.0 within a minute (we polled every 10 s from shortly after the landing; it changed in ~20 s).
- **Caveats:** one tiny repo; the build is Workers Builds' default `npx wrangler deploy`; we measured from our poll, not from the push itself.

## Not done
- A second real repository (es-toolkit) and a second agent vendor (Codex) were planned and not run.
