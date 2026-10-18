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
  workflow: "./.agents/skills/implement-spec/orchestrate.js",
  async: true,
  args: {
    specPath: ".scratch/<feature-slug>/spec.md",
    ticketsRef: "<the tracker's target for this feature's tickets>",
    integrationBranch: "<feature-slug>-integration",
    fullGate: "<the repo's full-suite command>",
    narrowGate: "<the repo's fast subset>",
    baseBranch: "<the repo's base branch>",
    maxParallel: 4,
    maxWaves: 6
  }
})
```

`specPath`, `ticketsRef`, `integrationBranch` and `fullGate` are **required**: the script returns a structured error naming the missing arg instead of launching children. `narrowGate` defaults to `fullGate`.

Adjust with `args` when the defaults don't match this run:

- `verifyOnly: true` — resume mode. Skips implementation entirely and runs only the closing sequence (final full-suite verify → three-axis review → fix pass → PR) over whatever the tickets already mark resolved. Use this to pick up a partially completed run without re-implementing finished tickets.
- `fullGateTickets` — only these tickets gate on the full suite; the rest gate narrow. Use when the slow tier (browser tests, a service that must be running) is bundled into a single ticket that merges last, so a tier that
  cannot pass yet does not falsely fail every other ticket mid-run. Default is `null`: every ticket gates on the full suite.
- `gateTimeoutMs` (default 15 min) — harness gate caps are shorter than most real suites; set this above the suite's runtime, from `docs/agents/verification.md`.
- `baseBranch` (default `main`) — the branch the review axes diff against and the PR targets.
- `prInstructions` — how this repo opens a request, from the verification doc and the tracker doc (`gh pr create`, `glab mr create`, a project-specific wrapper). Omit it when the repo has no PR surface and pass `skipPR: true`.
- `standardsDocs` — the standards-source paths the standards axis should read.
- `singleRetestCommand` — how to re-run one failing test, for the flake
  quarantine step. Include the placeholder form from the verification doc.
- `flakePattern` — extra regex vocabulary this repo's failures use to mean "transient" (timing helpers, settle assertions, a specific harness's wording).
- `implTimeoutMs` (default 45 min), `mergeTimeoutMs` (default 20 min), `maxRemediations` (default 2).
- `skipPR: true` — stop before the PR child.

After launching, **yield and wait for the workflow receipt** — do not implement tickets yourself, poll, or interleave ad-hoc fixes. If a child fails, the workflow's remediation ladder handles it (below); relaunch the same workflow (same script + args reuses finished children) rather than falling back to doing the work inline. Background completion wakes you natively.

For each complete implementation, manually launch a verification run with the `verifier` agent for an independent check that all acceptance criteria are satisfied.  

## What the workflow enforces (do not bypass)

- **Worktree isolation**: every implementer, fixer, and the review-fix pass run with `worktree: true` and `baseRef: refs/heads/<integrationBranch>`, a managed git worktree. The main checkout is never switched off the integration branch.
- **Verification gating**: every implementer/fixer/merger carries a `gate`. The gate runs on the host after the child completes, in that child's tree; a run is not `ok` unless the gate passes. Child claims alone never count as verified.
- **The tracker is the source of truth**: ticket state is re-read from the tracker every wave (the discovery cache is dropped whenever a wave merges, because a child may have resolved a ticket); subagents read and update tickets through `docs/agents/issue-tracker.md`. The script never trusts a child's self-report of resolution, and a ticket is only marked merged after its merger run verifies green on the integration branch.
- **Sparse context**: children get ticket references, not inlined spec text.
- **The target is the target**: the scout is told to report only the target's tickets, and discovery reports whether `refs/heads/<integrationBranch>` resolves before wave 1. A nonexistent target or branch ends the run with a structured error — it never falls back to "some nearby tickets/branch", which is how a placeholder in `args` can otherwise produce a confident review of unrelated work. If you want that check on a run whose scout reports no preflight, the script warns and continues; the merger still refuses a missing branch.
- **A review without a verdict is incomplete, not a pass**: each axis must end with `Review verdict: BLOCK` or `Review verdict: OK`. A missing line — or an axis that failed to run — suppresses the PR and escalates to you, because an unknown review state is not evidence of a clean one.

## The remediation ladder (what happens when a child fails)

The workflow does not abandon a ticket on first failure. Per ticket:

- **Timeout** → tier 1: revive the same child with `runs.run(key, { resume: runId, task })` — same session, same retained worktree. A retained resume reuses the child's stored contract, so no gate rides on it: the revived child self-verifies and the merge gate re-checks on the integration branch. Tier 2 (when there is no run id to resume, or the resume is rejected): a continue-child that locates the retained worktree from the repo's own worktree registry and finishes the partial work in place,
  reporting `WORKTREE_PATH` for the merger.
- **Likely flake** (a transient-looking single-test failure) → a quarantine recheck that re-runs *only that test* in the failed run's retained worktree (found via `git worktree list --porcelain`, never a fresh tree — a fresh one  would not contain the partial work). Transient → merge proceeds on the preserved patch; persistent or unrecoverable → the fixer below.
- **Gate failure** → a fixer child in a fresh managed worktree that applies the previous run's captured patch and repairs it — never a from-scratch re-implementation.
- **Merge failure** → one idempotent merger retry, then escalation.
- **After `maxRemediations`** → the ticket is **escalated, not abandoned**: the script emits a structured `ESCALATION:` line (run id, failure class, evidence paths) and stops spawning for that ticket. Dependents wait for the lead's decision instead of being silently poisoned.

When you (the lead) receive an `ESCALATION:`, decide deliberately:

1. **Resume/revive** the named child run (`subagent({ action: "resume", id })`) —  this keeps its session context and worktree. Prefer this for timeouts.
2. **Targeted fixer** — spawn a single fix child scoped to the reported failure (`run-fix-pass.js` wraps one; it takes `args.task` and `args.gate`, the repo's verification command, and isolates the child in a managed worktree —  pass `args.baseRef` to branch it from the integration branch).
3. **Park** the ticket and let the rest of the run finish; re-plan afterward.

## Steering rules 

- **Never steer a child that may be running a test suite.** A 60s-quiet "needs attention" notice usually means the child is mid-suite, not stuck. Steer pauses/interrupts the run. Check `status`/transcript first; for timed-out children use `resume`, never `steer`.
- The inactivity watchdog fires on *silence*, and suite-running children are silent by design. When in doubt, look at the transcript before acting.
