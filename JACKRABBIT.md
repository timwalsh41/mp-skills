# Jackrabbit workflow definition

This document defines the issue tracking workflow when leveraging Jackrabbit. Jackrabbit is a lightweight Jira-like agile project management tool based on tickets. The user will provide the Jackrabbit URL, from which you can access the ticket management API and documentation. The user will also specify what Jackrabbit project to use for the working repo.

Jackrabbit maps onto the standard workflow as follows:
- Specs are implemented as a ticket of issue type epic
- Tickets are implemented as Jackrabbit story tickets
    - When creating tickets as part of `/to-tickets` skill, fill out the description as well as the groomed fields (Approach, Files to Change, Test Plan, and Validation Plan), and move the tickets from the `Open` state to the `Groomed` state
    - When implementing tickets as part of the `/implement` or `/implement-spec` skill, change the ticket status from `Groomed` to `In Progress`, filling out the integration/feature branch name
    - Tickets should be transitioned from `In Progress` to `In Review` when ready for user Review
        - Typicall this would be when a PR is created, and the PR link should be added during the state transition
    - Transition the ticket from `In Review` to `Complete` once the feature/integration branch is merged to main, via PR or direct merge
- Use labels on tickets to represent triage status
