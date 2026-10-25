---
name: implement
description: "Implement a single ticket via an orchestration workflow."
disable-model-invocation: true
---

Orchestrate implementation of one ticket on a dedicated feature branch by launching an orchestration script. The script delegates to subagents — **implementer** (worktree-isolated), **reviewer-quality** + **reviewer-standards** (parallel), **verifier** (independent), and **pr-writer**. **Do not implement the ticket yourself in this context** — the script handles all code, review, verification, and PR through isolated children.

## Steps

1. **Read the ticket** (see `docs/agents/issue-tracker.md`). Groom first if needed.
2. **Create the feature branch.**
3. **Resolve** from `docs/agents/verification.md` and `docs/agents/issue-tracker.md`: the gate command, base branch, and PR command.
4. **Launch the orchestrator** and yield — background completion wakes you natively:

```js
subagent({ workflow: "~/.pi/agent/skills/implement/orchestrate.js", async: true, args: {
  ticketRef, gate, integrationBranch,   // required
  baseBranch, repoPath,                  // optional (default "main", detect)
  gateTimeoutMs, maxRemediations,        // optional (default 15min, 2)
  skipPR, prInstructions,                // optional (default false, repo default)
  standardsDocs, trackerHint,            // optional
  singleRetestCommand, agents            // optional
}})
```

Numeric args must be JSON numbers. Full arg documentation is in `orchestrate.js`.

## What the workflow enforces

- **Worktree isolation** — the implementer's managed worktree is the only tree touched.
- **Gate enforcement** — every child carries a gate that runs on the host; claims alone don't count.
- **Review verdict contract** — missing `Review verdict:` lines are incomplete, not pass; the PR is suppressed.
- **Independent verification** — a verifier child re-derives acceptance criteria from merged code.
- **No PR without clean reviews + verification.**
