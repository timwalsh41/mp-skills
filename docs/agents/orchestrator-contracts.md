# Child contract ledger

Every child these orchestrators spawn has exactly one success mechanism. Audits
and changes are checked against this table, so a contract is never rediscovered
from an incident. The rule underneath the table:

**Deterministic facts come from the host (gates); judgment comes from children
(structured output). Nothing is decided by scanning child prose.**

Mechanisms:

- **gate** - the host runs a command; its exit code decides. The child's prose is context only.
- **structured** - the child must finish by calling the harness's `structured_output` tool; the orchestrator reads parsed fields.
- **gate + structured** - both: the gate proves the tree, structured output reports the judgment.
- **default acceptance** - the implementer keeps the harness's attested acceptance plus its acceptance-report block and gate. Its judgment is the deliverable.

Enforced by `npm run test:workflows` (`tests/workflow-entry.test.mjs`), which
dry-runs both orchestrators against stub children and fails on:

- any `acceptanceRole` run param (agent config only; silently ignored by `runs.run`)
- any gate-decided child missing `acceptance: false`
- any prose-token decision scan (`Review verdict:`, `TRANSITION_APPLIED` regexes, `PR_CREATED:` matchers, trailer-grep idempotency)
- verdict-bearing children missing an `outputSchema`
- schema parity drift between `implement` and `implement-spec`

## implement/orchestrate.js

| Child (key) | Agent | Success mechanism | Structured shape |
|---|---|---|---|
| `preflight-clean-tree` | worker | gate: `test -z "$(git status --porcelain)"` | none (gate only), `acceptance: false` |
| `ensure-integration-branch` | worker | gate: `git rev-parse --verify refs/heads/<branch>` | none (gate only), `acceptance: false` |
| `groom-check-<ref>` | worker | structured: `groomed`, `missing` | GROOM_OUTPUT_SCHEMA |
| `transition-<phase>-<ref>` | worker | structured: `outcome` (`TRANSITION_APPLIED`/`TRANSITION_ALREADY_SET` pass) | TRANSITION_OUTPUT_SCHEMA, `acceptance: false` |
| `impl-t<ref>` | implementer | default acceptance + gate | acceptance-report block (implementer's deliverable) |
| `fix-t<ref>-w<n>` | implementer | default acceptance + gate | acceptance-report block |
| `merge-<retry>-<ref>` | merger | gate (narrow) + commit state, `acceptance: false` | none; idempotency decided by `git apply --check --reverse` on the captured patch, never by trailer grep |
| `fix-review-findings` | implementer | default acceptance + gate | acceptance-report block |
| `merge-fix-<ref>` | merger | gate + commit state, `acceptance: false` | none; same content-based idempotency |
| `verify-fix-merge-<ref>` | merger | gate + structured: `mergeState` | MERGE_STATE_OUTPUT_SCHEMA, `acceptance: false` |
| `review-<stage>-<axis>` (+ retries) | reviewer | structured: `verdict` (`OK`/`BLOCK`/`MISSING_TARGET`) | REVIEW_OUTPUT_SCHEMA |
| `verify` | verifier | structured: `verdict` (`OK`/`UNMET`) | VERIFY_OUTPUT_SCHEMA |
| `final-gate` | merger | gate (full), `acceptance: false` | none |
| `pr` | pr-writer | structured: `prUrl`, `noPrSurface` | PR_OUTPUT_SCHEMA |
| `confirm-merge-<ref>` | worker | structured: `confirmed` | CONFIRM_MERGE_OUTPUT_SCHEMA, `acceptance: false` |
| `cleanup-worktrees-<ref>` | worker | best effort (failure logged, never fatal) | none |

## implement-spec/orchestrate.js

Same table as above for shared child kinds, plus:

| Child (key) | Agent | Success mechanism | Structured shape |
|---|---|---|---|
| `ticket-graph(-forced)` | scout | structured-ish: JSON document parsed from output text. **Deliberate exception:** no `outputSchema`, because a model that answers with the JSON document as text is then rejected and discovery dies; see the comment in `readTicketGraph` | JSON envelope parsed by `statusesFromGraph` with per-object recovery |
| `continue-<wave>-t<ref>` | implementer | gate + structured: `worktreePath` | WORKTREE_PATH_OUTPUT_SCHEMA |
| `flake-recheck-<wave>-t<ref>` | implementer | structured: `outcome` | FLAKE_OUTPUT_SCHEMA |
| `merge-review-fixes` | merger | gate + commit state, `acceptance: false` | none; content-based idempotency |
| `resume-<wave>-t<ref>` | (retained resume) | inherits the original child's contract; `agent`/`gate` cannot be attached | n/a |

## Non-negotiable invariants

1. A green host gate plus a landed commit is a successful merger, regardless of its prose.
2. A missing structured verdict is a failure that goes through the retry/escalation ladder; it is never parsed into a pass.
3. The merger's "already merged" decision comes from `git apply --check --reverse <patch>` on the captured patch. Ticket trailers and `git log --grep` are context, never the decision (JRB-017: a fix merge was skipped because an earlier commit for the same ticket carried the trailer).
4. Tree cleanliness and branch existence are host facts. No child is asked to run `git status` and report a token.
5. Both orchestrators stay in contract parity. The tests fail the PR otherwise.
6. Any change to an orchestrate.js or an agent definition must pass `npm run test:workflows` before it is pushed: these scripts are loaded by every future run, and an unexecuted edit ships its crash with it (JRB-017: a `configErrors` ReferenceError pushed at 20:30 crashed the next run at 20:47).
