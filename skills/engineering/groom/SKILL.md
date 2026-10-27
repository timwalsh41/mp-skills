---
name: groom
description: Groom a raw ticket into a ready-for-work state by grilling to fill the groomed fields, then applying them and moving it to Groomed.
disable-model-invocation: false
---

# Groom

Bring a single raw ticket to a workable state, in place. Where `/to-tickets` turns a plan into *new* groomed tickets, `/groom` takes an *already-existing* ticket (one that arrived raw from triage, a wayfinder decision, or manual entry) and brings it to **Groomed**: it grills you to fill the groomed fields, then writes them and moves the ticket to the groomed status, so `/implement` has what it needs to start.

`/groom` is only for tickets that are not yet groomed. Run it on a ticket that `/to-tickets` produced (those are Groomed by construction) and you repeat work for nothing.

## Preconditions

The issue tracker must be configured. The repo's tracker conventions live in `docs/agents/issue-tracker.md`. If it is missing, tell the user to run `/setup-matt-pocock-skills`.

Read its **When a skill says "groom a ticket"** section to learn, for this repo's tracker: the groomed fields to fill, the status that marks a ticket groomed, and any labels a groomed ticket should receive. If that section is absent, report the gap and stop. The field names, the groomed status, and the "this ticket is ready for an agent" marker all vary by tracker, so they come from the doc, not from this skill.

## Process

### 1. Fetch the ticket

Take `<ticket>` (a number, URL, or path) and read it fully: title, body, current status, the existing values of the groomed fields, comments, and labels. Resolve a bare `#42` per the tracker doc: GitHub numbers issues and PRs in one space and needs disambiguation; GitLab and local are unambiguous; Jackrabbit is resolved as `<project_prefix>-<number>`.

### 2. Explore the codebase (recommended)

Before grilling, ground the conversation in what already exists. Search by domain concept, not the ticket's wording: the same passes `/triage` runs as its redundancy check. The aim is so the proposed Approach, Files to Change, Test Plan, and Validation don't contradict the code on disk. If the ticket is about a repo you are not working in, skip this and flag it to the user.

### 3. Grill

Call the Skill tool with "grilling". Scope the interview to this one ticket and propose concrete values for each groomed field the tracker doc demands, one frontier of questions at a time, numbered, with your recommended answer so "yes" accepts it. Do not act on the answers until the user confirms you have reached a shared understanding.

### 4. Apply the grooming

Write the groomed fields and move the ticket to the groomed status, exactly as `docs/agents/issue-tracker.md` prescribes for this tracker.

Grooming changes **status and groomed fields only**. It does **not** close the ticket, and it does **not** touch triage labels (that is `/triage`'s job), unless the tracker doc's grooming section explicitly says to.

### 5. Hand off

Report what changed and the ticket's new state. Offer `/implement` as the next step: it expects a Groomed ticket and moves it `Groomed → In Progress`.

## When not to use this

- The ticket is already Groomed: `/to-tickets` produced it, or `/groom` already ran. Re-grooming is busywork.
- You want to *create* tickets from a plan: use `/to-tickets` instead.
- You want to *categorize* an incoming issue: use `/triage` instead.
