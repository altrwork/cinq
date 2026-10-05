// The agent-facing MCP surface, stateless via createMcpHandler. Each tool is a thin wrapper over the same
// RepoDO calls the HTTP API uses, so MCP, CLI and UI cannot diverge.
// The agent's identity comes from its bearer key (verified in index.js before we get here).
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (r) => ({ isError: true, content: [{ type: 'text', text: `${r.status || 500}: ${r.error}` }] });
const out = (r) => (r.ok ? ok(r) : fail(r));

const HOW = `How this works: you register the job you are about to do (propose_intent) with the FEWEST tests that prove it
(usually 1 to 3 cases; more than 5 is refused), you get your own fork,
you work and push there, then submit. The platform checks your work against your tests, hidden tests you
cannot see and hard rules (stay inside allowed paths, never edit existing tests or .cinq/, no secrets, declare
dependency changes, protected paths and oversized jobs wait for a person), and lands
it on main only after another agent that did not write it has read the diff (a review). If it clashes with newer
work, or the reviewer blocks it, another agent rebuilds it.`;

export function createServer({ agent, env, defaultRepo }) {
  // An agent key is bound to the repo it was created for, so agents never need to name it.
  const repoStub = (repo) => {
    if (defaultRepo && repo && repo !== defaultRepo) throw new Error(`this agent key is for repo ${defaultRepo}, not ${repo}`); // a key never reaches another repo
    return env.REPO.get(env.REPO.idFromName(repo || defaultRepo || env.DEFAULT_REPO));
  };
  const repoArg = { repo: z.string().optional().describe('Repo name (defaults to this deployment\'s repo)') };
  const server = new McpServer({ name: 'cinq', version: '0.1.0' });

  server.registerTool('propose_intent', {
    description: `Register the job you are about to do, before writing code. ${HOW}\nkind "change" needs tests that FAIL on today's main (they prove the change); kind "keep" is for refactors where existing tests must keep passing. Call list_intents first: if another open job already changes your files, the reply warns you (overlaps); narrow your files, pick other work, or go ahead knowing whichever lands second is rebuilt on top. Returns your claim: a fork remote to clone, push to its main, then call submit.`,
    inputSchema: { ...repoArg, goal: z.string().describe('One or two sentences: what will be true when this is done'),
      allowed: z.array(z.string()).describe('Exact file paths you may change'),
      tests: z.record(z.string(), z.string()).optional().describe('New test files you are adding: {path: content}'),
      supersedes: z.record(z.string(), z.string()).optional().describe('ONLY if the goal genuinely changes behaviour that EXISTING tests pin: {existingTestPath: full new content}. Never edit existing tests in your fork; declare them here. A different agent reviews every such change before it can land.'),
      deps: z.array(z.string()).optional().describe('Package names whose dependency entries this job adds, changes or removes (package.json or the lockfile). Undeclared dependency changes are refused.'),
      plan: z.string().max(2000).optional().describe('One or two sentences: your approach and why. Recorded with the change so later readers know why it is there.'),
      kind: z.enum(['change', 'keep']).optional().describe('"change" (default): new behaviour, tests fail today. "keep": a refactor, existing behaviour must not change') },
  }, async ({ repo, ...input }) => out(await repoStub(repo).proposeIntent(agent, input)));

  server.registerTool('propose_plan', {
    description: `Use this instead of propose_intent when the person's ask has more than one independent part (most real asks do). Split the ask into a FEW tickets (usually 2 to 4; group parts that change the same files or area into one ticket), each able to land on its own, each shaped like a propose_intent job (goal, allowed files, tests that fail today, plan). You build the first ticket yourself (its claim comes back, as with propose_intent); crew agents build the rest, each on its own fork, examined and reviewed like any job. Name every file each ticket will need in its allowed list: a ticket that has to touch a file it didn't name is refused and rebuilt. Keep tickets' files apart where you can: tickets that share files are warned and the one that lands second is rebuilt on top. ${HOW}`,
    inputSchema: { ...repoArg, ask: z.string().max(8000).describe("The person's request, in their own words"),
      tickets: z.array(z.object({ goal: z.string(), allowed: z.array(z.string()), tests: z.record(z.string(), z.string()).optional(),
        supersedes: z.record(z.string(), z.string()).optional(), deps: z.array(z.string()).optional(), plan: z.string().max(2000).optional(),
        kind: z.enum(['change', 'keep']).optional() })).min(1).max(12).describe('One entry per independent part, in the order they should be built'),
      build: z.enum(['first', 'none']).optional().describe('"first" (default): you build the first ticket. "none": every ticket goes to the crew') },
  }, async ({ repo, ...input }) => out(await repoStub(repo).proposePlan(agent, input)));

  server.registerTool('house_rules', {
    description: 'The house rules a person set for this repo: the review criteria every change is held to, and which agents may review. Read them before you build, so your change meets them the first time.',
    inputSchema: { ...repoArg },
  }, async ({ repo }) => out(await repoStub(repo).houseRules()));

  server.registerTool('claim', {
    description: 'Take a job from the board that another agent needs done. In priority order: a fix-to-fit (adapt a landed change to a contract change that broke it), a rebuild (rebuild a change from its goal because it clashed or a reviewer blocked it), a REVIEW (read someone else\'s diff and pass or block it against the house rules, then submit_review), a BUILD (one ticket of someone\'s larger ask: build it on your fork and submit), or an EXAMINATION (write hidden tests for someone else\'s goal without seeing their code). Optionally name intentId, or kind "examine" / "review". The work order tells you what to do.',
    inputSchema: { ...repoArg, intentId: z.string().optional(), kind: z.enum(['examine', 'review']).optional() },
  }, async ({ repo, intentId, kind }) => out(await repoStub(repo).claim(agent, { intentId, kind })));

  server.registerTool('submit_tests', {
    description: 'Examiners only: hand in hidden tests for the intent you are examining, as {path: content}. They must fail on today\'s main (for a refactor job, pass on it). The author never sees them; the change cannot land until it passes them.',
    inputSchema: { ...repoArg, claimId: z.string(), tests: z.record(z.string(), z.string()),
      supersedeVerdicts: z.record(z.string(), z.object({ verdict: z.enum(['approve', 'deny']), reason: z.string() })).optional().describe('Required when the work order has reviewTestChanges: a verdict for every changed existing test file') },
  }, async ({ repo, claimId, tests, supersedeVerdicts }) => out(await repoStub(repo).submitTests(agent, claimId, tests, supersedeVerdicts)));

  server.registerTool('submit_review', {
    description: 'Reviewers only: hand in your verdict on the diff in your review work order. "pass" lets it land; "block" sends it back to be rebuilt by another agent with your findings (a second block parks it for a person). Block only for real problems, with at least one finding.',
    inputSchema: { ...repoArg, claimId: z.string(), verdict: z.enum(['pass', 'block']),
      findings: z.array(z.object({ file: z.string().min(1), line: z.number().int().min(0).describe('0 if not line-specific'), severity: z.enum(['low', 'medium', 'high', 'critical']), reason: z.string().min(1), rule: z.number().int().min(0).optional().describe('When the work order has houseRules: the number of the rule this breaks, or 0 if no rule covers it'),
        axis: z.enum(['spec', 'standards', 'lean']).optional().describe('spec: the goal; standards: house rules, guidelines, architecture; lean: something the goal does not need (redundant tests, dead code, needless abstraction)') })).max(50).optional(),
      summary: z.string().max(1000).optional().describe('One or two sentences: what you checked and why you passed or blocked it. Recorded with the change.') },
  }, async ({ repo, claimId, verdict, findings, summary }) => out(await repoStub(repo).submitReview(agent, claimId, { verdict, findings: findings || [], summary })));

  server.registerTool('submit', {
    description: 'Hand in your work after pushing it to your fork\'s main. The platform examines, reviews and lands it from here; you don\'t need to wait (status tells you how it went, if asked).',
    inputSchema: { ...repoArg, claimId: z.string(), generation: z.number().optional().describe('The generation from your work order: a stale hand-in from an older attempt is refused') },
  }, async ({ repo, claimId, generation }) => out(await repoStub(repo).submit(agent, claimId, generation)));

  server.registerTool('status', {
    description: 'Check (and wait for) the outcome of your claim. Waits up to waitSeconds (max 55) for a change. Calling it also renews your lease while you work.',
    inputSchema: { ...repoArg, claimId: z.string(), waitSeconds: z.number().max(55).optional() },
  }, async ({ repo, claimId, waitSeconds }) => out(await repoStub(repo).status(agent, claimId, waitSeconds || 0)));

  server.registerTool('release', {
    description: 'Give a claimed job back to the board (you cannot finish it).',
    inputSchema: { ...repoArg, claimId: z.string(), reason: z.string().optional() },
  }, async ({ repo, claimId, reason }) => out(await repoStub(repo).release(agent, claimId, reason)));

  server.registerTool('list_intents', {
    description: 'See what every agent is working on or has landed, with the files each open job changes and who holds it, so you do not duplicate or trample work. Check it before propose_intent.',
    inputSchema: { ...repoArg, state: z.string().optional() },
  }, async ({ repo, state }) => out(await repoStub(repo).listIntents(state, agent)));

  server.registerTool('get_intent', {
    description: 'Full detail of one intent: goal, allowed paths, its tests, state, how it landed. Hidden tests are never shown.',
    inputSchema: { ...repoArg, intentId: z.string() },
  }, async ({ repo, intentId }) => out(await repoStub(repo).getIntent(intentId, agent)));

  server.registerTool('get_receipt', {
    description: 'The receipt for a landed intent: which agent, which checks ran, how it landed. Read from the repo itself.',
    inputSchema: { ...repoArg, intentId: z.string() },
  }, async ({ repo, intentId }) => out(await repoStub(repo).getReceipt(intentId)));

  return server;
}
