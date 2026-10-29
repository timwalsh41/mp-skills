---
name: implement
description: "Implement a single ticket via an orchestration workflow."
disable-model-invocation: true
---

Orchestrate implementation of one ticket on its integration branch. The workflow delegates implementation, review, independent verification, and PR work to isolated subagents. Do not implement the ticket yourself in the lead context.

## Steps

1. Read the ticket and `docs/agents/issue-tracker.md`. Follow that document for grooming, ticket fields, status transitions, and resolution. If the ticket is not ready for implementation, groom it through the documented process before launching the workflow.
2. Read `docs/agents/verification.md` for the full gate, base branch, and PR instructions. Resolve the ticket's branch and integration details from the ticket and repo guidance.
3. Launch the orchestrator and yield. It creates the integration branch when needed, runs the implementation and review workflow, and opens a PR by default when the gates pass. The branch and PR instructions come from the repo docs.

```js
subagent({ workflow: "/home/pi/.pi/agent/skills/implement/orchestrate.js", async: true, args: {
  ticketRef, gate, integrationBranch,
  baseBranch, repoPath,
  gateTimeoutMs, implTimeoutMs,
  maxRemediations, maxReviewRetries,
  skipPR, prInstructions, prWaiverReason,
  finalizeMergedPR, prUrl, mergeRef,
  standardsDocs, trackerHint,
  singleRetestCommand, agents
}})
```

The script lives next to this skill. Use its absolute installed path, not `~/`, which resolves relative to the working directory. Numeric args must be JSON numbers. See `orchestrate.js` for the complete argument contract.

## Lifecycle and exceptions

- Lifecycle actions default to `docs/agents/issue-tracker.md`; do not require the prompt to pass transition commands. The workflow uses the documented actions to move an issue to In Progress before implementation and Ready for Review after a PR is created. A tracker that explicitly has no such transitions is reported as unsupported rather than guessed at. `transitionCommands` is an optional override for unusual integrations.
- Complete is a post-merge action, not a PR-creation action. After the user reports that the PR or integration branch was merged, rerun the workflow with `finalizeMergedPR: true` and `prUrl` or `mergeRef`. It confirms the merge using the repo docs before asking the tracker to complete the issue. It does not reimplement the ticket.
- `prWaiverReason` is only for an explicit user-approved waiver of completed review blockers. The workflow creates a draft request where supported, includes the reason and unresolved review findings, and reports a waived, non-green result. It cannot waive failed verification, incomplete reviews, or unfinished work.
- `skipPR: true` opts out of PR creation. Otherwise PR creation is attempted after the required verification and review gates pass. The PR writer reports `PR_CREATED: <url>` or `NO_PR_SURFACE`; Ready for Review is set only for a created request.

## What the workflow enforces

- **Worktree isolation:** implementation and review-fix work happen in managed worktrees.
- **Grooming gate:** an issue that fails the documented preflight is not implemented until it is groomed.
- **Gate enforcement:** every implementation and merge carries a host-run verification gate; claims alone do not count.
- **Review verdict contract:** a missing verdict is incomplete, not a pass, and suppresses the PR.
- **Independent verification:** a verifier re-derives acceptance criteria from the committed code before PR eligibility.
- **Conventional Commits:** the merger validates a Conventional Commit subject and an `Issue: <ref>` body trailer. The ticket trailer lets later runs recognize already-landed work.
- **PR gate:** no PR without passing verification, complete reviews, and verified acceptance criteria, except for the explicit review waiver described above.
- **Recovery:** transient UNVERDICTED reviews are retried, and implementation failures use the configured remediation ladder.

The PR gate does not change lifecycle status to Complete. A separate post-merge confirmation is required.
