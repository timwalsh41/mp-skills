---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

The goal is the entire spec implemented on a single **integration branch**, with every ticket resolved the way the issue tracker closes work.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

## Execution

Launch the orchestration workflow. Every value below comes from the step above:

```js
subagent({
  workflow: "/home/pi/.pi/agent/skills/implement-spec/orchestrate.js",
  async: true,
  args: {
    specRef: ".scratch/<feature-slug>/spec.md",
    ticketsRef: "<the tracker's target for this feature's tickets>",
    integrationBranch: "<feature-slug>-integration",
    fullGate: "<the repo's full-suite command>",
    narrowGate: "<the repo's fast subset>",
    baseBranch: "<the repo's base branch>",
    maxParallel: 4,
    maxWaves: 6,
    maxReviewRetries: 2,
    transitionCommands: { in_progress: "...", ready_for_review: "...", complete: "..." }
  }
})
```

The script lives next to this `SKILL.md` — launch it from the absolute path where it is installed (do not use `~/`, which resolves relative to cwd, not `$HOME`).

`specRef`, `ticketsRef`, `integrationBranch` and `fullGate` are **required**: the script returns a structured error naming the missing arg instead of launching children. `narrowGate` defaults to `fullGate`.

The harness accepts at most 16 `args` fields, and the list below is the full set — drop the ones this run does not need.

One run per integration branch at a time. Two runs on the same branch fight each other: one run's merger can land on top of the other's, and the second run's reviewers see work they did not ask about.

- `specRef` is the spec **as a reference**, not necessarily a file: either a path in the repo (`.scratch/<feature-slug>/spec.md`) or the tracker ticket/epic that holds it (`"JRB-001 (epic)"`). The script passes it to children as a pointer only. `specPath` is accepted as an alias.
- Pass numbers as JSON **numbers**. The script coerces a quoted number, but a quoted number is a different number to the harness.

Adjust with `args` when the defaults don't match this run:

- `verifyOnly: true` — resume mode. Skips implementation entirely and runs only the closing sequence (final full-suite verify → three-axis review → fix pass → PR) over whatever the tickets already mark resolved. Use this to pick up a partially completed run without re-implementing finished tickets.
- `fullGateTickets` — only these tickets gate on the full suite; the rest gate narrow. Use when the slow tier (browser tests, a service that must be running) is bundled into a single ticket that merges last, so a tier that
  cannot pass yet does not falsely fail every other ticket mid-run. Default is `null`: every ticket gates on the full suite.
- `gateTimeoutMs` (default 15 min) — harness gate caps are shorter than most real suites; set this above the suite's runtime, from `docs/agents/verification.md`.
- `baseBranch` (default `main`) — the branch the review axes diff against and the PR targets.
- `prInstructions` — how this repo opens a request, from the verification doc and the tracker doc (`gh pr create`, `glab mr create`, a project-specific wrapper). Omit it when the repo has no PR surface and pass `skipPR: true`. Say in it how the head branch reaches the remote — the request cannot be opened until the branch is pushed.
- `standardsDocs` — the standards-source paths the standards axis should read.
- `trackerHint` — a short pointer to the tracker's read, update and resolve operations, e.g. `"tracker: http://host/api/v1; read a ticket with curl -s http://host/api/v1/tickets/<id>; resolve it by setting its status line to resolved"`. Pass it when the repo's tracker doc is not in the tree the children work in (a gitignored `docs/agents/` never reaches a worktree), so a child can still read and close its own ticket.
- `repoPath` — the absolute path of the checkout this run integrates into. Children working in the main checkout are told where it is and must confirm it (`git rev-parse --show-toplevel`) before reporting any target as missing.
- `singleRetestCommand` — how this repo runs ONE narrow slice of tests. It is handed
  to the verifier child (as its targeted-test command) and to the flake
  quarantine recheck. Include the placeholder form from the verification doc.
- `maxReviewRetries` (default 2) — how many times to retry a review axis that returned no verdict (UNVERDICTED), e.g. due to a transient model-provider block like Cloudflare. Surviving verdicts from a partial `runs.all` fan-out are preserved; only the failed axes are retried.
- `transitionCommands` (optional) — a map of shell command templates keyed by lifecycle phase: `{ in_progress, ready_for_review, complete }`. Templates may reference `$TICKET_REF`, `$BRANCH`, and `$PR_URL`; they run via a lightweight `worker` child. `complete` fires after the PR is created. Omit to rely on description-based resolution only.
- `flakePattern — extra regex vocabulary this repo's failures use to mean "transient" (timing helpers, settle assertions, a specific harness's wording).
- `implTimeoutMs` (default **75 min**), `mergeTimeoutMs` (default 20 min), `maxRemediations` (default 2).
- `skipPR: true` — stop before the PR child.

After launching, **yield and wait for the workflow receipt** — do not implement tickets yourself, poll, or interleave ad-hoc fixes. If a child fails, the workflow's remediation ladder handles it (below); relaunch the same workflow (same script + args reuses finished children) rather than falling back to doing the work inline. Background completion wakes you natively.

Do **not** run a verification pass yourself: after each ticket's work is merged, the workflow spawns a `verifier` child that re-derives that ticket's acceptance criteria from the merged code and records the evidence in the ticket. A ticket only counts as merged when that independent check passes.

## What the workflow enforces (do not bypass)

- **Config errors are fatal**: every numeric arg is coerced and validated before launch; a malformed arg aborts the run with a structured error rather than entering the remediation ladder or being blamed on a ticket.
- **Worktree isolation**: every implementer, fixer, and the review-fix pass run with `worktree: true` and `baseRef: refs/heads/<integrationBranch>`, a managed git worktree. The main checkout is never switched.
- **Verification gating**: every implementer/fixer/merger carries a `gate`. The gate runs on the host after the child completes, in that child's tree; a run is not `ok` unless the gate passes. Child claims alone never count as verified.
- **The tracker is the source of truth**: ticket state is re-read every wave (cache dropped after a merge); the script never trusts a child's self-report. An implementer resolves its ticket before its patch is merged, so a ticket the tracker calls done whose work is not on the integration branch is implemented again rather than absorbed.
- **Sparse context**: children get ticket references, not inlined spec text.
- **The target is the target**: the scout reports only the target's tickets; a nonexistent target ends the run with a structured error (never "some nearby tickets/branch"). The integration branch is auto-created from `baseBranch` if missing. Children in the main checkout are given `repoPath` and must confirm it before reporting anything missing.
- **A review without a verdict is incomplete, not a pass**: each axis must end with `Review verdict: BLOCK` or `Review verdict: OK`. A missing line suppresses the PR and escalates.
- **An escalated ticket means the run is not complete**, so no request is opened over it.
- **Fix-merger acceptance fallback** — if the fix-merge child's acceptance is rejected but its git state is verified (changes present on the integration branch + gate green), the merge is treated as successful rather than escalating.
- **Grooming validation** — the scout reports a `groomed` field per ticket (true when the description has a `**Status:**` line and `- [ ]` acceptance criteria); ungroomed tickets trigger a warning and the implementer is instructed to groom in-place before implementing.
- **Patch capture resilience** — when a child times out before the harness captures its runId, children are pointed to a filesystem search (`ls -dt .../*.patch | head -5`) rather than a dead `unknown/` path.
- **Worktree cleanup** — child worktrees are removed automatically after all waves, remediation, reviews, and PR are complete (retained worktrees are needed during timeout recovery, so cleanup only happens at the end).
- **Whitespace-safe patch application** — mergers apply captured patches with `git apply --whitespace=fix --index` so trailing-whitespace warnings don't pollute the diff.

## The remediation ladder (what happens when a child fails)

The workflow does not abandon a ticket on first failure. Per ticket, a failure class routes to the appropriate recovery tier; after `maxRemediations` the ticket is **escalated, not abandoned** with a structured `ESCALATION:` line (run id, failure class, evidence paths).

| Failure | Tier 1 | Tier 2 | Tier 3 | Escalate after |
|---------|--------|--------|--------|-----------------|
| **Timeout** | `runs.run(key, { resume })` — revive same child/session/worktree (no gate; merge gate re-checks) | Continue-child finds retained worktree via `git worktree list --porcelain`, finishes partial work, reports `WORKTREE_PATH` | Fixer applies captured patch + repairs | `maxRemediations` |
| **Likely flake** | Quarantine recheck: re-run *only* the failing test in the failed run's retained worktree | — | Fixer | `maxRemediations` |
| **Gate failure** | — | — | Fixer: fresh worktree, apply + repair the captured patch | `maxRemediations` |
| **Merge failure** | Idempotent merger retry | — | — | 2 attempts |

A **configuration error** is not on this ladder: the run stops immediately with a structured error and no ticket is blamed.

When you receive an `ESCALATION:`, decide deliberately:

1. **Resume/revive** the named child run (`subagent({ action: "resume", id })`) — keeps session context and worktree. Prefer this for timeouts.
2. **Targeted fixer** — spawn a single fix child (`run-fix-pass.js` wraps one; takes `args.task`, `args.gate`, and `args.baseRef` to branch from the integration branch).
3. **Park** the ticket and let the rest of the run finish; re-plan afterward.

## Steering rules 

- **Never steer a child that may be running a test suite.** A "needs attention" notice usually means the child is mid-suite, not stuck. Steer pauses/interrupts the run. Check `status`/transcript first; for timed-out children use `resume`, never `steer`.
- The inactivity watchdog fires on *silence*, and suite-running children are silent by design. The children this workflow spawns carry a silence window longer than their gate and do not push control notices at all, so a gate-running child no longer wakes you to be told it is quiet. When in doubt, look at the transcript before acting.
