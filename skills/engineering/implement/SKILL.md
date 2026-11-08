---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the user-provided spec or tickets. If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask. Unless the user specifies otherwise, this work must result in a PR to the main branch for the user to review and approve.

**Steps**

1. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, accessible by all future subagents. This lets **implementer subagent(s)** focus on implementation rather than exploration.

2. Create an integration branch.

3. Use a fresh **implementer subagent** for each ticket, each in its own worktree on its own branch. Each implementer subagent:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - calls the Skill tool with `tdd` to implement the ticket;
   - merges the integration branch tip into its own branch before reporting done

4. When implementations are all complete, call the Skill tool with "code-review" to review the work. If findings block merge, then create a fresh implementer subagent to resolve. Rerun the skill tool with "code-review" to verify the resulting changes are satisfactory. Repeat this cycle as needed until all issues are resoved

5. Run typechecking and the full test suite to verify that all is green

6. Unless directed otherwise by the user, call the skill tool with "pr" to create the PR

7. Summarize status for the user, and offer to merge and then clean up all implementer agent subtrees. 
