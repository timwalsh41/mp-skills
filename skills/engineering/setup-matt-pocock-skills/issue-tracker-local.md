# Issue tracker: Local Markdown


<!-- This file belongs in the repo: the tracked AGENTS.md points at it, and the
     subagents read it from their worktrees. Do not git-ignore docs/agents/. -->

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## When a skill says "groom a ticket"

Used by `/groom`. A groomed local ticket carries the four implementation fields in its file body and a `Status: ready-for-agent` line near the top (this repo records triage state as a `Status:` line; see `triage-labels.md` for the role strings).

- **The groomed fields**, as sections in the issue file:
  - `## Approach`
  - `## Files to Change`
  - `## Test Plan`
  - `## Validation Steps`
- **Mark groomed**: set `Status: ready-for-agent` near the top of the file.
- **Scope**: grooming writes the file sections and the ready-for-agent status. It does **not** close the ticket or add other roles; that is `/triage`'s job.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
