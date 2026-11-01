---
name: teardown
description: Clean up the repo post-implementation 
disable-model-invocation: true
---

# Teardown

Clean up the repo after implementation of one or more tickets. Refer to the user input for the scope (e.g. a list of tickets, branches, session logs, etc.). Ensure first that all work has landed (PR merged to main); if not, then halt and ask for clarification. If so, then proceed with cleanup:

- Remove any worktrees associated with the change
- Delete local feature/fix branches associated with the change
- Ensure the feature/fix branch is deleted from the remote repo
- Pull the local changes from remote to main if they have not been already
- Close out any lingering processes from the session
