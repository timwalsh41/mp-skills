---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have a spec and its implementation issues. `/implement-spec` works them as a **task graph** on one integration branch, implementing only the ready frontier.

Before launching, read the target repo's `docs/agents/issue-tracker.md` for issue discovery, grooming, lifecycle transitions, and resolution. Read `docs/agents/verification.md` for gates, branches, and PR behavior. Use those docs as the source of tracker-specific operations. If no issue tracker is configured, tell the user to run `/setup-matt-pocock-skills`.

One run per integration branch. Parallel runs on the same branch can merge unrelated work and invalidate review scope.

## Launch

Resolve the required values from the repo docs. Supply host checks for every lifecycle status, PR lookup, and post-merge confirmation. A check returns 0 only if the requested state is true; do not launch if the necessary command cannot be constructed. Then launch and yield:

```js
subagent({
  workflow: "/home/pi/.pi/agent/skills/implement-spec/orchestrate.js",
  async: true,
  args: {
    specRef: "<spec path or tracker reference>",
    ticketsRef: "<tracker target for this spec's issues>",
    integrationBranch: "<feature-slug>-integration",
    fullGate: "<full verification command>",
    narrowGate: "<fast verification command>",
    repoPath: "<absolute checkout path>",
    transitionCheckCommands: {
      in_progress: "<tracker status check using $TICKET_REF>",
      ready_for_review: "<tracker status check using $TICKET_REF>",
      complete: "<tracker status check using $TICKET_REF>"
    },
    prCheckCommand: "<lookup of $PR_URL on $BRANCH>",
    mergeCheckCommand: "<confirmation $MERGE_REF contains $TICKET_REFS>"
  }
})
```

`specRef`, `ticketsRef`, `integrationBranch`, `fullGate`, `repoPath`, and applicable host checks are required. For `skipPR: true` omit the PR check; for `finalizeMergedPR: true` provide the merge and `complete` checks. Values substituted for `$TICKET_REF`, `$TICKET_REFS`, `$PR_URL`, `$MERGE_REF`, and `$BRANCH` are shell-quoted; put placeholders outside any other shell quotes. Use the script's argument header for optional settings and defaults. Use the absolute script path shown above, not `~/`. Pass numbers as JSON numbers. The script has no filesystem access, so resolve repo-specific values before launch.

The workflow owns implementation, verification, review, merging, and PR creation. Do not implement tickets in the lead context, poll, or interleave ad hoc fixes. If it returns an `ESCALATION`, let the user decide whether to resume, fix, or park the issue; retained worktrees are available for that decision.

## Lifecycle and PRs

- Tracker lifecycle writes default to the target repo's `docs/agents/issue-tracker.md`. Host `transitionCheckCommands` re-read the status after each write; an issue moves to Ready for Review only after the PR has been verified through `prCheckCommand`.
- A PR is attempted by default after final verification, complete reviews, and verification of every in-scope issue. `skipPR: true` stops at the integration branch. For a documented lack of PR surface, set `noPrSurface: true`; an unverified claim from the writer alone does not produce a green result.
- Complete is post-merge only. After the user reports a merge, rerun with `finalizeMergedPR: true`, `prUrl` or `mergeRef`, and a `mergeCheckCommand` that verifies the merge includes every `$TICKET_REFS` issue. It does not reimplement the issues.
- `prWaiverReason` is only for a user-authorized waiver of completed review blockers. It opens a draft PR where supported, records the reason and findings, and returns a non-green result. It never waives a failed final gate, incomplete review, or unresolved issue.
- An issue that fails the tracker-defined grooming preflight is not dispatched. Its dependents wait; independent groomed issues may proceed.

The orchestrator enforces host-run gates and independent acceptance verification. Incomplete, escalated, PR-failed, and waived runs retain worktrees for user-directed recovery. Successful, fully gated runs clean up child worktrees.

Every child's success mechanism (host gate, structured output, or implementer acceptance) is tabulated in [docs/agents/orchestrator-contracts.md](../../../docs/agents/orchestrator-contracts.md); `npm run test:workflows` enforces it.
