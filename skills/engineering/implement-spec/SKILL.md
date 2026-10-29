---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have a spec and its implementation issues. `/implement-spec` works them as a **task graph** on one integration branch, implementing only the ready frontier.

Before launching, read the target repo's `docs/agents/issue-tracker.md` for issue discovery, grooming, lifecycle transitions, and resolution. Read `docs/agents/verification.md` for gates, branches, and PR behavior. Use those docs as the source of tracker-specific operations. If no issue tracker is configured, tell the user to run `/setup-matt-pocock-skills`.

One run per integration branch. Parallel runs on the same branch can merge unrelated work and invalidate review scope.

## Launch

Resolve the required values from the repo docs, then launch the orchestrator and yield:

```js
subagent({
  workflow: "/home/pi/.pi/agent/skills/implement-spec/orchestrate.js",
  async: true,
  args: {
    specRef: "<spec path or tracker reference>",
    ticketsRef: "<tracker target for this spec's issues>",
    integrationBranch: "<feature-slug>-integration",
    fullGate: "<full-suite command>",
    repoPath: "<absolute checkout path>"
  }
})
```

`specRef`, `ticketsRef`, `integrationBranch`, and `fullGate` are required. Use the script's argument header for optional settings and defaults. Use the absolute script path shown above, not `~/`. Pass numbers as JSON numbers. The script has no filesystem access, so resolve repo-specific values before launch.

The workflow owns implementation, verification, review, merging, and PR creation. Do not implement tickets in the lead context, poll, or interleave ad hoc fixes. If it returns an `ESCALATION`, let the user decide whether to resume, fix, or park the issue; retained worktrees are available for that decision.

## Lifecycle and PRs

- Tracker lifecycle actions default to the target repo's `docs/agents/issue-tracker.md`. Issues move to In Progress before implementation and Ready for Review only after a PR is confirmed created.
- A PR is attempted by default after final verification, complete reviews, and verification of every in-scope issue. `skipPR: true` stops at the integration branch. A repo with no PR surface reports `NO_PR_SURFACE` and leaves the branch available for direct integration.
- Complete is post-merge only. After the user reports that the PR or integration branch has merged, rerun with `finalizeMergedPR: true` and `prUrl` or `mergeRef`. The workflow confirms that the merge includes the in-scope issues before transitioning them to Complete. It does not reimplement the issues.
- `prWaiverReason` is only for a user-authorized waiver of completed review blockers. It opens a draft PR where supported, records the reason and findings, and returns a non-green result. It never waives a failed final gate, incomplete review, or unresolved issue.
- An issue that fails the tracker-defined grooming preflight is not dispatched. Its dependents wait; independent groomed issues may proceed.

The orchestrator enforces host-run gates and independent acceptance verification. Incomplete, escalated, PR-failed, and waived runs retain worktrees for user-directed recovery. Successful, fully gated runs clean up child worktrees.
