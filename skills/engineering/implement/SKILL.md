---
name: implement
description: "Implement a single ticket via an orchestration workflow."
disable-model-invocation: true
---

Orchestrate implementation of one ticket on its integration branch. The workflow delegates implementation, review, independent verification, and PR work to isolated subagents. Do not implement the ticket yourself in the lead context.

## Steps

1. Read the ticket and `docs/agents/issue-tracker.md`. Follow that document for grooming, ticket fields, status transitions, and resolution. If the ticket is not ready for implementation, groom it through the documented process before launching the workflow.
2. Read `docs/agents/verification.md` for the full and fast gates, base branch, and PR instructions. Resolve the ticket's branch and integration details. From the repo's tracker and request docs, supply host commands that return 0 only when each lifecycle transition reached its target status, the created PR exists, or the supplied merge reference contains the issue. If the required check cannot be constructed, stop and report the missing contract instead of launching.
3. Launch the orchestrator and yield. It creates the integration branch when needed, runs the implementation and review workflow, and opens a PR by default when the gates pass. The branch and PR instructions come from the repo docs.

```js
subagent({ workflow: "/home/pi/.pi/agent/skills/implement/orchestrate.js", async: true, args: {
  ticketRef, fullGate, narrowGate, integrationBranch, repoPath,
  transitionCheckCommands, prCheckCommand
  // Add only applicable options such as skipPR, noPrSurface, or
  // finalizeMergedPR + mergeRef + mergeCheckCommand (at most 16 args).
}})
```

The script lives next to this skill. Use its absolute installed path, not `~/`, which resolves relative to the working directory. Numeric args must be JSON numbers. See `orchestrate.js` for the complete argument contract.

## Lifecycle and exceptions

- Lifecycle **writes** default to `docs/agents/issue-tracker.md`; `transitionCommands` is an optional override. Supply `transitionCheckCommands` with commands for `in_progress` and, when a PR is expected, `ready_for_review`. Finalization uses `complete`. Each command must re-read the tracker and exit 0 only when the issue is in that phase's target status. Use `$TICKET_REF` and `$PHASE` as placeholders outside any other shell quotes; the workflow quotes the values. A missing check stops the run before any child launches.
- Complete is post-merge only. For `finalizeMergedPR: true`, provide `prUrl` or `mergeRef` and `mergeCheckCommand` to independently verify the reference includes `$TICKET_REF` (and optionally `$BRANCH`). It does not reimplement the issue.
- `prWaiverReason` is only for an explicit user-approved waiver of completed review blockers. The workflow creates a draft request where supported, includes the reason and unresolved review findings, and reports a waived, non-green result. It cannot waive failed verification, incomplete reviews, or unfinished work.
- `skipPR: true` opts out of PR creation. Otherwise supply `prCheckCommand` to independently look up `$PR_URL` on `$BRANCH` after the PR writer returns it. Use `noPrSurface: true` only if the repo docs explicitly rule out a request surface. An unverified URL or unsupported no-PR claim is a failure, not a green run.

## What the workflow enforces

- **Worktree isolation:** implementation and review-fix work happen in managed worktrees.
- **Grooming gate:** an issue that fails the documented preflight is not implemented until it is groomed.
- **Gate enforcement:** every implementation and merge carries a host-run verification gate; claims alone do not count.
- **Structured verdicts:** reviews, verification, the PR writer, transitions, merge confirmation, and grooming all report through the harness's structured_output tool (reviewer/verifier/pr-writer schemas live in the agent definitions' frontmatter). The orchestrator reads parsed fields and never scans child prose for decision tokens. A missing structured verdict is incomplete, not a pass, and suppresses the PR.
- **Host-decided facts:** a valid, clean checkout and branch, the captured patch applied on the integration branch with an issue commit, lifecycle states, and PR or merge existence are verified by host-run gates. Merger and final-gate children use `acceptance: false` so missing prose reports do not reject green gates.
- **Independent verification:** a verifier re-derives acceptance criteria from the committed code before PR eligibility.
- **Conventional Commits:** the merger validates a Conventional Commit subject and an `Issue: <ref>` body trailer. Whether the work is already merged is decided from the captured patch's content against the branch, tolerating reformatting pre-commit hooks (never trailer grep); a verified already-merged no-op passes. Escalations name the exact failed gate clause.
- **PR gate:** no PR without passing verification, complete reviews, and verified acceptance criteria, except for the explicit review waiver described above.
- **Recovery:** transient UNVERDICTED reviews are retried, and implementation failures use the configured remediation ladder.

Every child's success mechanism (host gate, structured output, or implementer acceptance) is tabulated in [docs/agents/orchestrator-contracts.md](../../../docs/agents/orchestrator-contracts.md); `npm run test:workflows` enforces it.

The PR gate does not change lifecycle status to Complete. A separate post-merge confirmation is required.
