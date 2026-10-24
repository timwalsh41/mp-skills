## What it does

`groom` takes a single ticket sitting raw: no approach, no file list, no test plan, nothing an agent can build from, regardless of whether it was filled in by a human, handed off from triage, or produced by a decision. It brings that ticket to the repo's groomed state. It does this the way a human grooming a ticket would: a short [grilling](https://www.aihero.dev/ai-coding-dictionary/grilling) session to nail down the approach, files to change, test plan, and validation steps, then a write of those fields plus the status move that marks the ticket ready for an [agent](https://www.aihero.dev/ai-coding-dictionary/agent) to pick up.

The defining constraint: `groom` does not invent the answer. It proposes concrete values and waits for you to accept or correct them, round by round, so the fields end up reflecting what you actually want built, not what the model guessed. It reads the groomed-field names and the groomed status from your repo's `docs/agents/issue-tracker.md`, so the same skill works whether your tracker is GitHub (a `ready-for-agent` label plus body sections), GitLab, Jackrabbit (`Open → Groomed` with the four API fields), or local markdown.

## When to reach for it

You invoke this by typing `/groom <ticket>` and the agent won't reach for it on its own. Run it on a ticket that needs grooming and that no other skill already owns.

| What you have | Where to go |
| --- | --- |
| A spec or plan to turn into groomed tickets | [to-tickets](https://aihero.dev/skills-to-tickets) |
| A raw incoming issue to categorize | [triage](https://aihero.dev/skills-triage) |
| A raw existing ticket that just needs grooming | `groom` (this skill) |
| A groomed ticket ready to build | [implement](https://aihero.dev/skills-implement) |

## Prerequisites

`groom` reads and writes a tracker, so [setup-matt-pocock-skills](https://aihero.dev/skills-setup-matt-pocock-skills) must have configured one for this repo, along with a **When a skill says "groom a ticket"** section in `docs/agents/issue-tracker.md` that states the groomed fields, the groomed status, and the ready-for-agent marker for that tracker. If that section is absent, the skill reports the gap and stops.

## The interview is scoped to one ticket

`/groom` does not re-run the open-ended idea sharpening that [/grill-with-docs](https://aihero.dev/skills-grill-with-docs) starts. The grilling here is narrow: a frontier of concrete proposals for this ticket's approach, files, test plan, and validation. Each question carries a recommended answer, so a "yes" accepts it and a "no" steers it. The loop ends not when the design tree is exhausted, but when every groomed field the tracker doc requires has a committed value and the ticket can move to the groomed status.

## Common questions

**How is this different from /to-tickets?**
Both end in a Groomed ticket, which is why the split matters. `to-tickets` *creates* the tickets (from a spec or conversation) and grooms them at creation. `groom` takes a ticket that already exists and grooms it in place. If you have a plan and no tickets yet, reach for `to-tickets`. If you have a raw ticket sitting in the open, reach for `groom`.

**Why doesn't groom change triage labels too?**
Because ticket status and triage labels are independent state. Triage labels (`needs-triage`, `ready-for-agent`, and so on) are `triage`'s job; the groomed status is `groom`'s. On Jackrabbit the two never collide. On trackers with no groomed status (GitHub, GitLab, local markdown) the ready-for-agent marker is itself a label, and that is the one exception `groom` makes. Otherwise, keep the two skills apart: `groom` fills fields and sets the groomed status, `triage` owns the role labels.

**What if my tracker doc has no grooming section?**
The skill reports the gap and stops. The section is small: it names the groomed fields, the groomed status, and the ready-for-agent marker for your tracker, and it is what lets `groom` stay tracker-agnostic. If you lack it, run `/setup-matt-pocock-skills` and add the section to `docs/agents/issue-tracker.md`.

## It's working if

- You walked through one grilling session for the ticket and every groomed field was accepted on the first proposed value.
- The ticket now carries the implementation fields (Approach, Files to Change, Test Plan, Validation) with values you recognize as your own.
- The ticket's status flipped to the groomed marker your tracker uses (`Groomed` on Jackrabbit, `ready-for-agent` on GitHub/GitLab/local), so a run of [implement](https://aihero.dev/skills-implement) would queue it next.
- A bare `#42` you handed it resolved to the right ticket without you disambiguating its tracker.

## Where it fits

A standalone, run-anytime skill sitting between [triage](https://aihero.dev/skills-triage) and [implement](https://aihero.dev/skills-implement): triage says a ticket is worth specifying, `groom` does the specifying, implement builds it. It is the in-place counterpart to the grooming that [to-tickets](https://aihero.dev/skills-to-tickets) does at creation time, with the same end state but a different input. It depends on [grilling](https://aihero.dev/skills-grilling) for the interview, and on a tracker configured by [setup-matt-pocock-skills](https://aihero.dev/skills-setup-matt-pocock-skills). When you're unsure which skill or flow fits, point to [ask-matt](https://aihero.dev/skills-ask-matt) for the whole map.
