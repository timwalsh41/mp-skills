## What it does

`implement` turns one groomed issue into a tested, reviewed change on its integration branch. It runs implementation, review, and independent verification through isolated [subagents](https://www.aihero.dev/ai-coding-dictionary/subagent), then opens a pull request when the configured gates pass. Its defining constraint is one issue per run: it does not coordinate an issue graph or implement unrelated work.

Lifecycle operations come from the target repo's `docs/agents/issue-tracker.md`, not from hard-coded tracker commands. The workflow moves an issue to In Progress before implementation, to Ready for Review after creating a PR, and to Complete only after a separate post-merge confirmation.

## When to reach for it

You invoke this by typing `/implement`, and the agent won't reach for it on its own. Reach for it when one groomed issue, or a small standalone spec, is ready to build. For a dependency graph of several issues, use [`implement-spec`](https://aihero.dev/skills-implement-spec) instead.

The target repo should describe its issue-tracker workflow in `docs/agents/issue-tracker.md` and its test and PR commands in `docs/agents/verification.md`. The agent must also be able to derive commands to check the issue status and confirm a created PR or completed merge independently. Without those checks, it stops before launching. Groom an issue first when its tracker documentation says it is not ready.

## The run

The workflow uses fast gates during implementation and checks that the captured patch and issue commit are on the integration branch. It then runs standards and quality reviews, independent acceptance verification, and the full gate on the final reviewed commit. A review fix gets fresh reviews before PR eligibility. It opens a PR by default only when every gate passes; `skipPR` opts out.

A user can explicitly waive completed review blockers with `prWaiverReason`. That produces a draft PR where the repo supports drafts, records the unresolved findings and reason, and is reported as non-green. It does not waive a failed test gate, incomplete review, or unmet acceptance criteria.

After a PR or direct integration merge, invoke the post-merge finalization mode with its URL or merge reference. The workflow checks the merge using the repo docs before transitioning the issue to Complete. Opening a PR alone never marks it Complete.

## Common questions

**The implementation finished, but why isn't the issue Complete?**

The issue moves to Ready for Review after the PR is created. Complete is reserved for a later finalization run that confirms the PR or integration branch was merged. If the tracker has no lifecycle transitions, its documented workflow determines how completion is recorded.

**Can it open a pull request automatically?**

Yes. PR creation is the default after verification and reviews pass. Pass `skipPR: true` to stop at the integration branch. PR commands and any tracker-specific rules come from the target repo docs. If those docs define no PR surface, the workflow reports that and leaves the verified work on the integration branch.

**What happens when a reviewer blocks the change?**

The workflow makes one isolated fix pass and reviews the updated commit again. If findings remain or a review is incomplete, it suppresses the PR rather than looping. A user can explicitly waive completed blockers for a non-green draft PR; failed gates, incomplete reviews, and unmet criteria cannot be waived.

**Does `/implement` handle several dependent issues?**

No. It owns one issue at a time. Use [`implement-spec`](https://aihero.dev/skills-implement-spec) when the work is an issue graph with blocking relationships.

## It's working if

- The run stops before coding when the issue is not groomed or the checkout is dirty or invalid. It also stops when it cannot verify the required tracker or request state.
- The issue moves to In Progress before implementation and Ready for Review only after a PR is independently confirmed to exist.
- Any review fix is freshly reviewed, and the full gate passes on the final reviewed commit before a PR can open.
- The PR is suppressed when verification fails or reviews are incomplete or blocked without an explicit waiver.
- Complete is recorded only after the merge is independently confirmed.
- A PR waiver is visible in the draft request and the workflow result remains non-green.
- Evidence sections in the ticket are reconciled, never duplicated, even across remediation and rerun cycles.

## Where it fits

`implement` is the per-issue build step in `grill-with-docs → to-spec → to-tickets → implement → retro`. [`to-tickets`](https://aihero.dev/skills-to-tickets) produces the issues; [`tdd`](https://aihero.dev/skills-tdd) drives the red-green implementation loop; [`implement-spec`](https://aihero.dev/skills-implement-spec) is the issue-graph alternative. See [`ask-matt`](https://aihero.dev/skills-ask-matt) for the map of the full flow.
