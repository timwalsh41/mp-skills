# Child contract ledger

Every child these orchestrators spawn has exactly one success mechanism. Audits
and changes are checked against this table, so a contract is never rediscovered
from an incident. The rule underneath the table:

**Deterministic facts come from the host (gates); judgment comes from children
(structured output). Nothing is decided by scanning child prose.**

Mechanisms:

- **gate** - the host command emits `{"verified":true}` through a typed gate only after its checks pass. The orchestrator requires `result.structuredOutput.verified === true`. Gate-only children use `agentContract: { version: 1 }` so a missing acceptance report cannot reject a successful check; a child's successful exit cannot replace host evidence.
- **structured** - the child must finish by calling the harness's `structured_output` tool; the orchestrator reads parsed fields. For reviewer, verifier and pr-writer children the schema lives in the agent definition's frontmatter (`outputSchema:`), so every spawn — orchestrator-driven or an ad-hoc lead continuation (JRB-018) — is provisioned with the tool; those run calls carry no `outputSchema` param.
- **structured then gate** - separate children: the first reports a judgment, then a typed host gate checks the resulting external state. Typed gates cannot be combined with a child's `outputSchema`.
- **default acceptance** - the implementer keeps the harness's attested acceptance plus its acceptance-report block and gate. Its judgment is the deliverable.

Enforced by `npm run test:workflows` (`tests/workflow-entry.test.mjs`), which
dry-runs both orchestrators against stub children and fails on:

- any `acceptanceRole` run param (agent config only; silently ignored by `runs.run`)
- gate-decided children with no `acceptance: false`, versioned agent contract, or typed host proof
- any prose-token decision scan (`Review verdict:`, `TRANSITION_APPLIED` regexes, `PR_CREATED:` matchers, trailer-grep idempotency)
- verdict-bearing run calls that carry an `outputSchema` param (schemas travel with the agent frontmatter), or agent definitions missing their frontmatter schema
- schema parity drift between `implement` and `implement-spec` (schemas, merger gate body)
- shared-helper parity drift between `implement` and `implement-spec` (every helper that is byte-identical by contract), and absence of the transition phase-boundary clause in either script's transition task

## implement/orchestrate.js

| Child (key) | Agent | Success mechanism | Structured shape |
|---|---|---|---|
| `preflight-clean-tree` | worker | typed host gate: valid Git checkout and empty porcelain | `verified: true`, `agentContract: { version: 1 }` |
| `preflight-check-commands` | worker | typed host gate: runs every lead-supplied check command once under `/bin/sh`; fails only when a command cannot execute (rc 2 = shell syntax error, 126 = not executable, 127 = command not found). Exit 0 (state true) and 1 (state false) are valid verdicts and pass. `implement-spec` uses sentinel ticket refs, which discovery resolves later | `verified: true`, versioned contract |
| `verify-fix-noop` (`verify-fix-noop-<ref>` in implement) | worker | typed host gate: empty captured fix patch, clean uncommitted fixer worktree when findable, main checkout clean on the integration branch, intermediate gate green. Proves a fixer that changed nothing (e.g. every finding adjudicated out of scope) is a valid fix-loop outcome, not a merge failure (JRB-019) | `verified: true`, versioned contract |
| `ensure-integration-branch` | worker | typed host gate: named local branch exists | `verified: true`, versioned contract |
| `groom-check-<ref>` | worker | structured: `groomed`, `missing` | GROOM_OUTPUT_SCHEMA |
| `transition-<phase>-<ref>` | worker | structured: outcome must be `TRANSITION_APPLIED` or `TRANSITION_ALREADY_SET` | TRANSITION_OUTPUT_SCHEMA, `acceptance: false` |
| `check-transition-<phase>-<ref>` | worker | typed host gate re-reads tracker status after a positive report | `verified: true`, versioned contract |
| `impl-t<ref>` | implementer | default acceptance + gate | acceptance-report block (implementer's deliverable) |
| `fix-t<ref>-w<n>` | implementer | default acceptance + gate | acceptance-report block |
| `merge-<retry>-<ref>` | merger | typed host gate: correct branch, clean tree, captured patch's content on the branch (formatter-tolerant: temp-index tree comparison modulo whitespace, walking the first-parent chain from HEAD to the merge-base), issue trailer exists, narrow suite passes; each clause labels its own failure | `verified: true`, versioned contract; retries get distinct keys |
| `fix-review-findings` | implementer | default acceptance + gate | acceptance-report block |
| `merge-fix-<ref>` | merger | same typed host patch/commit gate | `verified: true`; patch presence, not a trailer alone, decides idempotency |
| `verify-fix-merge-<ref>` | worker | same typed host patch/commit gate | `verified: true`, no model merge verdict |
| `review-<stage>-<axis>` (+ retries) | reviewer | structured: `verdict` (`OK`/`BLOCK`/`MISSING_TARGET`) | schema from the reviewer agent's frontmatter; run call carries none |
| `verify` | verifier | structured: `verdict` (`OK`/`UNMET`) | schema from the verifier agent's frontmatter |
| `final-gate` (`final-verify` in implement-spec) | worker | typed host gate (full) on integration branch | `verified: true`, versioned contract |
| `pr` | pr-writer | structured: `prUrl`, `noPrSurface` | schema from the pr-writer agent's frontmatter; no-PR claim needs lead-confirmed `noPrSurface` |
| `confirm-pr` | worker | typed host gate: query `$PR_URL` on `$BRANCH` after writer completes | `verified: true`, versioned contract |
| `confirm-merge-<ref>` | worker | structured `confirmed` | CONFIRM_MERGE_OUTPUT_SCHEMA, `acceptance: false` |
| `check-merge-<ref>` | worker | typed host gate checks merge reference after a positive report | `verified: true`, versioned contract |
| `cleanup-worktrees-<ref>` | worker | best effort (failure logged, never fatal) | none |

## implement-spec/orchestrate.js

Same table as above for shared child kinds, plus:

| Child (key) | Agent | Success mechanism | Structured shape |
|---|---|---|---|
| `ticket-graph(-forced)` | scout | structured: complete `tickets` array and `preflight`; missing or malformed graphs fail closed, never per-object recovery | GRAPH_OUTPUT_SCHEMA, `acceptance: false` |
| `continue-<wave>-t<ref>` | implementer | gate + structured: `worktreePath` | WORKTREE_PATH_OUTPUT_SCHEMA |
| `flake-recheck-<wave>-t<ref>` | implementer | structured: `outcome` | FLAKE_OUTPUT_SCHEMA |
| `merge-review-fixes` | merger | same typed host patch/commit gate | `verified: true`; content-based idempotency |
| `resume-<wave>-t<ref>` | (retained resume) | inherits the original child's contract; `agent`/`gate` cannot be attached | n/a |

## Non-negotiable invariants

1. A merger succeeds only when its host gate verifies the exact captured patch on the correct, clean branch, a matching issue commit, and passing tests. A green test command alone is not enough.
2. A missing structured verdict is a failure that goes through the retry/escalation ladder; it is never parsed into a pass.
3. The merger's "already merged" decision comes from `git apply --check --reverse <patch>` on its own captured patch. The host rechecks this postcondition; the ticket trailer corroborates commit identity but never substitutes for patch presence.
4. Valid checkout, tree cleanliness, branch existence, tracker status, PR existence, and merge confirmation are host facts. The lead provides tracker/PR commands from the target repo docs; missing checks fail before child launch. Host gates execute those commands with `/bin/sh`, not the lead's bash shell, so the check-command preflight rejects a command that cannot run there (rc 2/126/127) before any child work. A check command that runs and exits non-zero is a valid false verdict, not a preflight failure. No child prose substitutes for a host check.
5. Both orchestrators stay in contract parity: byte-identical shared helpers (schemas, gate bodies, preflight bodies, utility functions) are asserted equal by `npm run test:workflows`, and helpers that differ structurally (`patchLocation`/`patchHint`, `reviewAxisTask`, `checkoutHint`) are documented divergences, not drift. Tests use disposable Git repositories to exercise merger and preflight host commands, not only stubbed child responses.
6. Any change to an orchestrate.js or an agent definition must pass `npm run test:workflows` before it is pushed: these scripts are loaded by every future run, and an unexecuted edit ships its crash with it (JRB-017: a `configErrors` ReferenceError pushed at 20:30 crashed the next run at 20:47).
