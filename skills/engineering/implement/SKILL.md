---
name: implement
description: "Implement a piece of work based on a spec or ticket."
disable-model-invocation: true
---

Orchestrate the implementation of the work described by the user in a ticket. Create a feature branch and create a dedicated worktree using `treehouse`.

Invoke the `implementer` subagent to make the relevant code changes. Provide as task input:
- **Ticket** — the one ticket to execute, named by its reference and its target 
- **Spec path** — is a standard input to this subagent, in this case this is an independent ticket so no spec is provided
- **Integration branch / worktree base**
- **Gate command** — this repo's verification command
- **Ticket vocabulary** — how this this repo's tracker marks "done", where the answer goes, and the acceptance-criterion form

Invoke two code reviewer subagents, `reviewer-quality` and `reviewer-standards`, simultaneously to review along those two complementary axes. Provide as input to the quality reviewer the fixed reference point and the diff to review, e.g. `git diff <fixed point>...HEAD`, and explicitly state that there is no separate spec. Provide as input to the standards reviewer the same fixed point and diff, as well as the coding standards document for this repo (e.g. `CODING_STANDARDS.md` or `CONTRIBUTING.md`) 

If either reviewer flags blocking concerns, then trigger a new `implementer` subagent to resolve it, providing again the appropriate inputs and direction.

Once review is resolved, trigger a `verifier` agent to perform final verification. Provide as input the ticket and the target branch. Use an `implementer` subagent as needed to resolve verification failures.

Once complete, report back to the user and await further instruction. Offer to merge changes to main, raise a PR to main, and tear down the worktree. If the user requests a PR, use the `pr-writer` subagent, providing as input the feature branch and destination branch, the PR creation process details, the ticket reference, and evidence (gate/test results and review outcome).
