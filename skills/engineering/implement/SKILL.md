---
name: implement
description: "Implement a single ticket via an orchestration workflow."
disable-model-invocation: true
---

Orchestrate implementation of one ticket on a dedicated feature branch by launching an orchestration script. The script delegates to subagents — **implementer** (worktree-isolated), **reviewer-quality** + **reviewer-standards** (parallel), **verifier** (independent), and **pr-writer**. **Do not implement the ticket yourself in this context** — the script handles all code, review, verification, and PR through isolated children.

## Steps

1. **Read the ticket** (see `docs/agents/issue-tracker.md`). Groom first if needed
2. **Feature branch** — the workflow auto-creates `integrationBranch` from `baseBranch` if it doesn't exist yet (via a lightweight `worker` child in the main checkout), so no manual pre-creation is needed.
3. **Resolve** from `docs/agents/verification.md` and `docs/agents/issue-tracker.md`: the gate command, base branch, and PR command.
4. **Launch the orchestrator** and yield — background completion wakes you natively:

```js
subagent({ workflow: "/home/pi/.pi/agent/skills/implement/orchestrate.js", async: true, args: {
  ticketRef, gate, integrationBranch,    // required
  baseBranch, repoPath,                  // optional (default "main", detect)
  gateTimeoutMs, implTimeoutMs,          // optional (default 15min, 75min)
  maxRemediations, maxReviewRetries,     // optional (default 2, 2)
  transitionCommands,                    // optional (default none)
  skipPR, prInstructions,                // optional (default false, repo default)
  standardsDocs, trackerHint,            // optional
  singleRetestCommand, agents            // optional
}})
```

> **Path note:** Use an absolute path to the script, do not use `~` as shorthand for the home directory. The `~` is resolved relative to the working directory (not `$HOME`) by the harness, which produces `ENOENT`. The script lives at the installed path of the `implement` skill; use that full path.

Numeric args must be JSON numbers. Full arg documentation is in `orchestrate.js`.

## What the workflow enforces

- **Worktree isolation** — the implementer's managed worktree is the only tree touched.
- **Gate enforcement** — every child carries a gate that runs on the host; claims alone don't count.
- **Review verdict contract** — missing `Review verdict:` lines are incomplete, not pass; the PR is suppressed.
- **Independent verification** — a verifier child re-derives acceptance criteria from merged code.
- **No PR without clean reviews + verification.**
- **UNVERDICTED reviews are retried** — a review axis that completes without a verdict (e.g. from a transient model-provider block like Cloudflare) is retried up to `maxReviewRetries` times; surviving verdicts from a partial fan-out are preserved.
- **Fix-merger acceptance fallback** — if the fix-merge child's acceptance is rejected but its git state is verified (changes present on branch + gate green), the merge is treated as successful.
- **Tracker-agnostic transitions** — `transitionCommands` opts into lifecycle status transitions (`in_progress` before implementation, `ready_for_review` after PR creation, `complete` after PR merge); omit to rely on description-based resolution only.
- **Patch capture resilience** — when the implementer times out before the harness captures its runId, the fixer is pointed to a filesystem search command rather than a dead `unknown/` path.
- **Grooming pre-flight** — a lightweight worker child checks that the ticket's description has a `**Status:**` line and `- [ ]` acceptance criteria before implementation begins; if not, the lead is warned to groom it.
- **Worktree cleanup** — child worktrees that persist after completion are removed automatically by a cleanup worker after the final phase.
- **Whitespace-safe patch application** — the merger applies captured patches with `git apply --whitespace=fix --index` so trailing-whitespace warnings in HTML templates don't pollute the diff.
