// implement-spec Orchestration Workflow (remediation-ladder rewrite, 2026-10-15)
//
// Runs INSIDE the pi subagent workflow sandbox. That sandbox is a plain JS
// statement body with top-level await and NO fs/shell/require/tools — every
// action on the world goes through child agents via runs.run / runs.all.
//
// Contract with the invoking lead agent:
//   subagent({ workflow: "./.agents/skills/implement-spec/orchestrate.js",
//              args: { ... }, async: true })
//
// args (plain JSON, <=16KiB). REPO-SPECIFIC VALUES ARE PASSED IN, NEVER
// GUESSED: the lead resolves them from docs/agents/issue-tracker.md (where the
// spec and tickets live, how work closes) and docs/agents/verification.md
// (check commands, base branch, PR surface). This script has no filesystem
// access, so it carries no project defaults and fails fast on missing ones.
//   specPath           REQUIRED  e.g. ".scratch/<feature-slug>/spec.md"
//   ticketsRef         REQUIRED  e.g. ".scratch/<feature-slug>/issues"
//   integrationBranch  REQUIRED  named branch only, e.g. "<feature-slug>-integration"
//   fullGate           REQUIRED  the repo's full-suite command
//   narrowGate         default = fullGate; the repo's fast subset
//   maxParallel        default 4     concurrent implementer worktrees
//   maxWaves           default 6     frontier re-scan rounds
//   skipPR             default false
//   verifyOnly         default false. Skip implementation entirely and run
//                      only the closing sequence (final verify, reviews, fix,
//                      PR) over whatever the tickets already mark
//                      resolved. Resume mode for mid-stream pickups.
//   fullGateTickets    default null = every ticket gates on the FULL suite.
//                      When only some tickets own the slow tier (browser tests,
//                      a service that must be running), pass e.g. [15]: those
//                      gate FULL, the rest gate NARROW so a tier that cannot
//                      pass yet cannot falsely fail every other run.
//   gateTimeoutMs      default 15 min — harness gate caps are shorter than most
//                      real suites; take this number from the verification doc
//   implTimeoutMs      default 45 min per implementer/fixer/continue child
//   mergeTimeoutMs     default 20 min per merger
//   maxRemediations    default 2 remediation attempts per ticket before
//                      escalation to the lead
//   baseBranch         default "main" — what the review axes diff against and
//                      the request targets; from the verification doc
//   prInstructions     how THIS repo opens a pull/merge request (CLI + flags,
//                      per the verification and tracker docs). Omit alongside
//                      skipPR: true when the repo has no request surface.
//   standardsDocs      the paths this repo documents as coding standards, for
//                      the standards axis
//   singleRetestCommand  how to re-run ONE failing test (flake quarantine),
//                      placeholder form: "pytest <file>::<name> -q",
//                      "npm test -- <path> -t <name>", "go test ./pkg -run <Name>"
//   flakePattern       extra regex vocabulary this repo's transient failures
//                      use, appended to the generic set
//   agents             role-name map { scout, implementer, merger, prWriter,
//                      reviewerStandards, reviewerSpec, reviewerQuality } for
//                      projects whose agent definitions use other names
//   implTimeoutMs      default 45 min per implementer/fixer/continue child
//   mergeTimeoutMs     default 20 min per merger
//   maxRemediations    default 2 remediation attempts per ticket before
//                      escalation to the lead
//
// Enforcement (invariants unchanged from the 2026-10-15 rewrite):
//   - EVERY implementer/fixer runs in its own managed git worktree
//     (worktree:true, baseRef = integration branch). The parent checkout is
//     never switched; merges happen via captured patches/handoff manifests.
//   - Every implementer/fixer/merger carries a verification gate that runs on
//     the host in that child's tree; a run is not ok unless the gate passes.
//     Child claims alone never count as verified.
//   - Ticket state is re-read from the tracker every wave by a scout child;
//     the script never trusts a child's self-report of resolution.
//   - A review axis that returns no 'Review verdict:' line is INCOMPLETE, not
//     a pass: the PR is suppressed and the lead is escalated. (Silently
//     reading a missing verdict as OK was how a crashed reviewer green-lit a
//     whole run.)
//
// Remediation ladder (per ticket; replaces the old "fail -> permanent" list):
//   implementer (attempt 1)
//     ├─ timeout      → 1) runs.run(key, { resume: runId, task }) revives the
//     │                  same session + worktree (cheapest recovery; carries
//     │                  no gate, so the child self-verifies and the merge
//     │                  gate re-checks); else 2) a continue-child that locates
//     │                  the retained worktree from the repo's worktree
//     │                  registry and finishes the partial work in place,
//     │                  reporting WORKTREE_PATH for the merger.
//     ├─ likely flake → a quarantine recheck that re-runs ONLY that failing
//     │                  test in the FAILED RUN'S RETAINED worktree (found via
//     │                  `git worktree list --porcelain`). Transient → merge
//     │                  proceeds on the preserved patch; persistent → fixer.
//     ├─ gate failure → a fixer child in a FRESH managed worktree that applies
//     │                  the previous run's captured patch and repairs it
//     │                  (partial work is preserved via the patch; no
//     │                  from-scratch re-implementation).
//     ├─ merge failure→ one idempotent merger retry, then escalation.
//     └─ after maxRemediations the ticket is ESCALATED, not abandoned: the
//        script emits a structured escalation (run id, failure class,
//        evidence paths) and stops spawning for that ticket. Dependents wait
//        for the lead's decision instead of being silently poisoned.

// ---------------------------------------------------------------------------
// Configuration (args are frozen plain JSON; plain-JS defaults below)
// ---------------------------------------------------------------------------
const A = args || {};
const specPath = A.specPath || null;
const ticketsRef = A.ticketsRef || null;
const integrationBranch = A.integrationBranch || null;
const FULL_GATE = A.fullGate || null;

// Repo-specific args have no fallback: running a gate that does not exist in
// this repo burns a remediation cycle per ticket, and merging into a branch
// nobody named is worse. Bail before any child launches.
const missingArgs = [];
if (!specPath) missingArgs.push("specPath");
if (!ticketsRef) missingArgs.push("ticketsRef");
if (!integrationBranch) missingArgs.push("integrationBranch");
if (!FULL_GATE) missingArgs.push("fullGate");
if (missingArgs.length) {
  return {
    ok: false,
    error: "implement-spec is missing required args: " + missingArgs.join(", ") +
      ". Resolve them from docs/agents/verification.md (gates, branches) and " +
      "docs/agents/issue-tracker.md (spec + ticket locations) and relaunch."
  };
}

const maxParallel = A.maxParallel || 4;
const maxWaves = A.maxWaves || 6;
const skipPR = !!A.skipPR;
const verifyOnly = !!A.verifyOnly;
const baseRef = "refs/heads/" + integrationBranch;
const BASE_BRANCH = A.baseBranch || "main";
const PR_INSTRUCTIONS = A.prInstructions || null;
const STANDARDS_DOCS = A.standardsDocs ||
  "the files this repo documents as coding standards (search for CODING_STANDARDS.md, CONTRIBUTING.md, and anything AGENTS.md points at)";
const RETEST_COMMAND = A.singleRetestCommand || null;

// Default Markdown-body conventions for the completion instructions handed to
// children. The tracker doc (docs/agents/issue-tracker.md) is the authority;
// these only seed the task text for trackers whose tickets use a Markdown body.
const STATUS_FIELD = "Status";
const ANSWER_HEADING = "## Answer";
const RESOLVED_STATUSES = ["resolved", "wontfix"];
// A run key safe for any tracker's ticket reference (paths, #42, PROJ-123).
function keyOf(ref) { return String(ref).replace(/[^a-zA-Z0-9._-]+/g, "_"); }

// Child roles. Projects that define these agents under other names pass an
// `agents` map instead of editing this script.
const ROLES = A.agents || {};
const AG = {
  scout: ROLES.scout || "scout",
  implementer: ROLES.implementer || "implementer",
  merger: ROLES.merger || "merger",
  prWriter: ROLES.prWriter || "pr-writer",
  reviewerStandards: ROLES.reviewerStandards || "reviewer-standards",
  reviewerSpec: ROLES.reviewerSpec || "reviewer-spec",
  reviewerQuality: ROLES.reviewerQuality || "reviewer-quality"
};

const IMPL_TIMEOUT_MS = A.implTimeoutMs || 45 * 60 * 1000;
const MERGE_TIMEOUT_MS = A.mergeTimeoutMs || 20 * 60 * 1000;
// The harness default gate cap is 120s, under the real
// suite runtime. EVERY gate must carry an explicit generous deadline — so
// children get the launch object, never a bare command string.
const GATE_TIMEOUT_MS = A.gateTimeoutMs || 15 * 60 * 1000;
const MAX_REMEDIATIONS = A.maxRemediations || 2;

// Gate commands are args-only
const NARROW_GATE = A.narrowGate || FULL_GATE;
const fullGateTickets = A.fullGateTickets || null;
function gateObj(command) { return { command: command, timeoutMs: GATE_TIMEOUT_MS }; }
function gateFor(ref) {
  if (!fullGateTickets) return gateObj(FULL_GATE);
  return gateObj(fullGateTickets.indexOf(ref) >= 0 ? FULL_GATE : NARROW_GATE);
}
// The command STRING, for prompt text. Interpolating a gate *object* into a
// task renders "[object Object]", which is what children were being told to
// run. Anything user-facing needs .command via this helper.
function gateCommand(ref) { return gateFor(ref).command; }

// Transient-failure vocabulary; repos can add their own wording via
// args.flakePattern (an invalid pattern degrades to the generic set).
let FLAKE_RE;
try {
  FLAKE_RE = new RegExp("flaky|flake|settle|race condition|non-deterministic|intermittent" +
                        (A.flakePattern ? "|" + A.flakePattern : ""), "i");
} catch (eFlake) {
  FLAKE_RE = /flaky|flake|settle|race condition|non-deterministic|intermittent/i;
  emit("implement-spec: ignoring invalid args.flakePattern (" + eFlake + "); using the generic set");
}

emit("implement-spec: spec=" + specPath + " tickets=" + ticketsRef +
      " integration=" + integrationBranch + " base=" + BASE_BRANCH +
      " maxParallel=" + maxParallel + " maxWaves=" + maxWaves +
      " gates=[full: " + FULL_GATE + "]" +
      (NARROW_GATE !== FULL_GATE ? " [narrow: " + NARROW_GATE + "]" : "") +
      " gateTimeoutMs=" + GATE_TIMEOUT_MS +
      " maxRemediations=" + MAX_REMEDIATIONS +
      (verifyOnly ? " verifyOnly" : "") +
      (skipPR ? " skipPR" : ""));

// ---------------------------------------------------------------------------
// Helpers — plain functions returning promises ONLY (nested async is
// rejected by workflow validation).
// ---------------------------------------------------------------------------

// Wave 0/per-wave discovery child: enumerate the run's tickets and the
// blocker graph from the configured issue tracker. No typed gate here — the
// gate command's own stdout must be the JSON document, and discovery has no
// natural command to emit it; instead the script parses the child's returned
// output text (statusesFromGraph) and fails loudly if it cannot.
function readTicketGraph() {
  const task = [
    "Enumerate this run's tickets from the configured issue tracker.",
    "The tracker target for this run: " + ticketsRef,
    "Use the tracker convention your role defines. Do NOT assume tickets are files.",
    "Read ONLY that target. If it does not exist, or matches no tickets, return",
    'an empty tickets array. Never substitute a similar-looking target, another',
    "feature's tickets, or issues you found by searching: an empty answer is the",
    "correct answer for an empty target, while a plausible answer about someone",
    "else's tickets would be read as a verified run over this one.",
    "For EACH ticket output one object with:",
    "  ref: the ticket's reference in this tracker (e.g. 07, #42, PROJ-123),",
    "  title: the ticket title,",
    "  resolved: true when the tracker marks the ticket closed/done, else false,",
    "  blockedBy: the refs of every ticket this one is blocked by ([] if none).",
    "Keep each object on ONE line. Compact JSON, no whitespace.",
    "If a ticket cannot be read at all, append 'UNREADABLE:<ref>' for it.",
    "",
    "Preflight, reported in the same JSON document:",
    "  trackerConfigured: true when a usable issue tracker is configured; if",
    "  not, report false and stop.",
    "  integrationBranchExists: run `git rev-parse --verify " + baseRef + "` and",
    "  report true only if it exits 0; integrationBranch: the name you tested.",
    "  Report only. Never create, fetch, switch to, or merge that branch.",
    "",
    "Your FINAL response must begin with ONLY this JSON document (no prose",
    "before or inside it):",
    '{"tickets":[{"ref":"07","title":"...","resolved":false,"blockedBy":[]}],',
    ' "preflight":{"trackerConfigured":true,"integrationBranchExists":true,"integrationBranch":"' + integrationBranch + '"}}'
  ].join("\n");
  return runs.run("ticket-graph", {
    label: "Read ticket graph from " + ticketsRef,
    agent: AG.scout,
    task: task,
    timeoutMs: 10 * 60 * 1000,
    quiet: true,
    outputSchema: {
      type: "object",
      required: ["tickets"],
      properties: {
        tickets: {
          type: "array",
          items: {
            type: "object",
            required: ["ref", "resolved", "blockedBy"],
            properties: {
              ref: { type: "string" },
              title: { type: "string" },
              resolved: { type: "boolean" },
              blockedBy: { type: "array", items: { type: "string" } }
            }
          }
        },
        preflight: {
          type: "object",
          properties: {
            trackerConfigured: { type: "boolean" },
            integrationBranchExists: { type: "boolean" },
            integrationBranch: { type: "string" }
          }
        }
      }
    }
  });
}

// Read the preflight object out of the discovery child's JSON envelope, when it
// reported one. Absent is not a failure — the caller warns and carries on.
function preflightFromGraph(result) {
  const text = String((result && result.output) || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && parsed.preflight ? parsed.preflight : null;
  } catch (e) {
    return null;  // the tolerant per-object recovery path keeps no envelope
  }
}

function statusesFromGraph(result) {
  // Parse the JSON document out of the child's returned output text. The
  // runtime may append artifact notices after the JSON, hence the slice.
  // Robustness: models occasionally emit truncated JSON (observed: missing
  // the outer closing brace), so on parse failure fall back to extracting
  // every complete {...} object individually and keeping the ticket-shaped
  // ones — a truncated TAIL only loses tickets whose object was cut mid-way.
  const text = (result && result.output) || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && parsed.tickets) return parsed.tickets;
    } catch (e) {
      emit("ticket-graph: strict parse failed (" + e + "); attempting per-object recovery");
      const recovered = [];
      const re = /\{[^{}]*\}/g;
      let m;
      while ((m = re.exec(slice)) !== null) {
        try {
          const obj = JSON.parse(m[0]);
          if (obj && obj.ref !== undefined && obj.resolved !== undefined) recovered.push(obj);
        } catch (e2) { /* skip incomplete object */ }
      }
      if (recovered.length) {
        emit("ticket-graph: recovered " + recovered.length + " ticket object(s)");
        return recovered;
      }
    }
  }
  return [];
}

// One implementer child: isolated worktree off the integration branch,
// verified by the gate running on the host afterwards.
function spawnImplementer(ticket, wave) {
  const key = "impl-" + wave + "-t" + keyOf(ticket.ref);
  const task = [
    "Implement EXACTLY ONE ticket, end to end, using TDD (red-green-refactor).",
    "",
    "Ticket (read it first, using the tracker convention your role defines): " + ticket.ref,
    "Full spec for background context only: " + specPath,
    "",
    "Rules:",
    "- Implement only this ticket. Other tickets belong to other workers.",
    "- Check off every `- [ ]` acceptance criterion in the ticket as you",
    "  satisfy it, and set `**" + STATUS_FIELD + ":** " + RESOLVED_STATUSES[0] + "` ONLY when all are checked.",
    "- EDIT the existing '**" + STATUS_FIELD + ":**' line in place — never append a second one.",
    "- Append a short implementation summary under '" + ANSWER_HEADING + "' in the ticket.",
    "- Write/update tests for every criterion (unit/integration/E2E per spec).",
    "- Your tree already branches from " + integrationBranch + "; do NOT create",
    "  branches, worktrees, or spawn subagents.",
    "- Do NOT run git commit — leave your changes uncommitted in the worktree;",
    "  the orchestrator captures and merges them.",
    "",
    "Return a concise summary: what you implemented, test results, decisions."
  ].join("\n");
  return runs.run(key, {
    label: "Implement ticket " + ticket.ref + ": " + ticket.title,
    agent: AG.implementer,
    task: task,
    worktree: true,
    baseRef: baseRef,
    timeoutMs: IMPL_TIMEOUT_MS,
    gate: gateFor(ticket.ref),
    quiet: true
  });
}

// Timeout remediation tier 1: revive the SAME child (same session, same
// retained worktree) with runs.run(key, { resume: runId, task }) — the only
// resume shape the workflow sandbox has; there is no runs.resume, and the old
// `typeof runs.resume` guard made this tier dead code that silently dropped
// every timeout onto the continue-child. Returns a runs.run-shaped result, or
// null when there is no run id / the resume is rejected, so the caller can
// fall back to the continue-child.
//
// A retained resume reuses the child's stored contract, so `agent` and `gate`
// cannot be attached to it: the revived child self-verifies, and the merge
// gate re-verifies on the integration branch before the ticket counts merged.
function tryResume(runId, ref, wave) {
  if (!runId) {
    emit("ticket " + ref + ": no run id to resume; using continue-child fallback");
    return null;
  }
  // Both shapes of failure must degrade to the continue-child: a rejected
  // launch (async) and a preflight rejection thrown at call time (sync).
  try {
    return runs.run("resume-" + wave + "-t" + keyOf(ref), {
      resume: runId,
      task: "You timed out mid-ticket. Continue from where you left off in your " +
        "own worktree (your partial changes are still there). Finish the remaining " +
        "acceptance criteria, run the gate yourself until green: " + gateCommand(ref) +
        ", then finish with the acceptance-report block.",
      timeoutMs: IMPL_TIMEOUT_MS
    }).catch(function(e) {
      emit("ticket " + ref + ": resume rejected (" + e + "); using continue-child fallback");
      return null;
    });
  } catch (eSync) {
    emit("ticket " + ref + ": resume launch threw (" + eSync + "); using continue-child fallback");
    return null;
  }
}

// Timeout remediation tier 2: a fresh child that finds the timed-out run's
// RETAINED worktree and finishes the partial work in place. No worktree:true
// here — it works directly in the existing worktree, so it must report the
// path back for the merger (WORKTREE_PATH handshake).
function spawnContinueChild(ticket, runId, wave) {
  const key = "continue-" + wave + "-t" + keyOf(ticket.ref);
  const task = [
    "REMEDIATION: a previous implementer for ticket " + ticket.ref + " timed",
    "out mid-implementation. Its partial, uncommitted work still exists in a",
    "managed git worktree. Its run id: " + (runId || "unknown"),
    "",
    "Recover and finish that work — do NOT start over:",
    "1. Find the worktree the timed-out run used. Do NOT assume where worktrees",
    "   live: from the repo checkout run `git worktree list --porcelain` and take",
    "   the entry whose path contains this run id (managed worktrees are named",
    "   pi-worktree-<runId>-<index> under the configured worktree base). If the",
    "   run reported artifact paths, use those. If nothing matches, say so rather",
    "   than reimplementing.",
    "2. cd into that worktree; git status shows the partial changes. Read the",
    "   ticket (" + ticket.ref + ") for the remaining acceptance criteria.",
    "3. Finish the remaining criteria, keep the gate green yourself: " + gateCommand(ticket.ref),
    "4. Leave changes uncommitted. Do NOT commit, stage, or spawn subagents.",
    "",
    "The ABSOLUTE LAST LINE of your final response MUST be exactly:",
    "WORKTREE_PATH: /absolute/path/to/the/worktree",
    "so the orchestrator can hand your worktree to the merger."
  ].join("\n");
  return runs.run(key, {
    label: "Continue ticket " + ticket.ref + " (finish timed-out work in place)",
    agent: AG.implementer,
    task: task,
    timeoutMs: IMPL_TIMEOUT_MS,
    gate: gateFor(ticket.ref)
  });
}

// Gate-failure remediation: a fixer child in a FRESH managed worktree that
// applies the previous run's captured patch and repairs it. The worktree is
// new but the WORK is not from scratch — it starts from the previous patch.
function spawnFixer(ticket, priorResult, wave) {
  const key = "fix-" + wave + "-t" + keyOf(ticket.ref);
  const manifestHint = (priorResult && priorResult.artifactPaths || []).join(" ");
  const runId = priorResult && priorResult.runId;
  const task = [
    "REMEDIATION: the implementer for ticket " + ticket.ref + " completed but",
    "FAILED its verification gate. Its work is preserved as a captured patch;",
    "your job is to repair it, not rewrite it from scratch.",
    "",
    "Ticket: " + ticket.ref,
    "Previous run id: " + (runId || "unknown"),
    "Candidate manifest/artifact paths: " + (manifestHint || "(search by the run id below)"),
    "The run's handoff artifacts live under the subagent artifact root, e.g.",
    "  ls -d \"${TMPDIR:-/tmp}\"/pi-subagents-*/async-subagent-runs/" + (runId || "<runId>") + "/",
    "",
    "Steps:",
    "1. Locate the previous run's handoff manifest / captured patch.",
    "2. Apply it to YOUR worktree: git apply --index <patch>",
    "   (your worktree already branches from " + integrationBranch + ").",
    "3. Run the gate: " + gateCommand(ticket.ref),
    "4. Fix the failures the gate reports. Stay within this ticket's scope.",
    "5. Re-run the gate until green, then finish with the acceptance-report block.",
    "",
    "If the patch cannot be located or applied, report FAILURE clearly and",
    "change nothing."
  ].join("\n");
  return runs.run(key, {
    label: "Fix ticket " + ticket.ref + " (repair after gate failure)",
    agent: AG.implementer,
    task: task,
    worktree: true,
    baseRef: baseRef,
    timeoutMs: IMPL_TIMEOUT_MS,
    gate: gateFor(ticket.ref)
  });
}

// Merger child: applies the implementer's captured patch (located via the
// handoff manifest, or directly from a reported worktree path for
// continue-children) onto the integration branch in the main checkout, then
// re-verifies the gate there. The commit check is idempotent so a retried
// merger after a partial merge succeeds cleanly.
function spawnMerger(ticket, implResult, wave, worktreePath) {
  const manifestHint = (implResult && implResult.artifactPaths || []).join(" ");
  const key = "merge-" + wave + "-t" + keyOf(ticket.ref);
  const gate = gateFor(ticket.ref);
  const source = worktreePath
    ? [
        "The implementer worked directly in a retained worktree at:",
        "  " + worktreePath,
        "Capture its uncommitted changes from there, e.g.:",
        "  git -C " + worktreePath + " diff > /tmp/ticket-" + keyOf(ticket.ref) + ".patch",
        "then apply in the main checkout: git apply --index /tmp/ticket-" + keyOf(ticket.ref) + ".patch"
      ]
    : [
        "The implementer ran in a managed worktree; its patch is recorded in a",
        "handoff manifest. Candidate manifest/artifact paths:",
        (manifestHint ? manifestHint : "(none provided — inspect handoffs/ under the session artifact dir)")
      ];
  const task = [
    "Merge one completed implementer's work into " + integrationBranch + ".",
    "",
    "Ticket: " + ticket.ref,
    "",
    "Implementer changes source:",
    source.join("\n"),
    "",
    "Steps:",
    "1. Confirm the main checkout is on " + integrationBranch + " and clean",
    "   (git status). If it is dirty or on another branch, STOP and report.",
    "2. If a commit implementing this ticket ALREADY exists on the integration",
    "   branch (git log --grep 'ticket " + ticket.ref + "'), report that the",
    "   merge was already done and exit successfully — do not merge twice.",
    "3. Apply the implementer's changes (per the source above). If the patch is",
    "   empty or already applied, note that and continue.",
    "4. Commit: git commit -m \"Implement ticket " + ticket.ref + ": " + ticket.title + "\"",
    "5. Re-run the verification gate yourself as well: " + gate.command,
    "6. Do NOT delete branches or run any worktree-manager commands.",
    "",
    "If the patch cannot be found or applied, report FAILURE clearly and",
    "change nothing.",
    "",
    "Return: merge status, commit hash, gate result."
  ].join("\n");
  return runs.run(key, {
    label: "Merge ticket " + ticket.ref + " into " + integrationBranch,
    agent: AG.merger,
    task: task,
    timeoutMs: MERGE_TIMEOUT_MS,
    gate: gate
  });
}

// Three-axis review over the integrated branch, run in parallel.
function spawnReviews(wave) {
  const axisTask = function(axis, focus) {
    return [
      "You are the " + axis + " reviewer for the implement-spec workflow.",
      "Review the work integrated on branch " + integrationBranch + " in this",
      "checkout (git log/diff against " + BASE_BRANCH + " as needed). Focus: " + focus,
      "Spec: " + specPath + "  Tickets: " + ticketsRef,
      "",
      "Review ONLY that target. First confirm it exists: if the branch named",
      "above does not resolve, or the spec/ticket paths are missing, do NOT",
      "pick a nearby branch, another feature's tickets, or the current",
      "checkout and review that instead — a confident report about the wrong",
      "work is worse than no report. In that case answer with one line:",
      "'Review verdict: MISSING_TARGET' plus what was absent, and stop.",
      "",
      "Report concrete findings with file:line references. Otherwise end with",
      "exactly one line: 'Review verdict: BLOCK' if there are must-fix defects,",
      "or 'Review verdict: OK' if there are none. No other final line is a",
      "verdict; the orchestrator treats a missing one as an unfinished review."
    ].join("\n");
  };
  return runs.all([
    {
      key: "review-standards-" + wave,
      label: "Review standards axis",
      agent: AG.reviewerStandards,
      task: axisTask("standards", "conformance to " + STANDARDS_DOCS + ", plus the repo's conventions"),
      timeoutMs: MERGE_TIMEOUT_MS
    },
    {
      key: "review-spec-" + wave,
      label: "Review spec axis",
      agent: AG.reviewerSpec,
      task: axisTask("spec", "does the integrated work satisfy the spec and ticket acceptance criteria"),
      timeoutMs: MERGE_TIMEOUT_MS
    },
    {
      key: "review-quality-" + wave,
      label: "Review quality axis",
      agent: AG.reviewerQuality,
      task: axisTask("quality", "correctness, robustness, test coverage, maintainability"),
      timeoutMs: MERGE_TIMEOUT_MS
    }
  ]);
}

// ---------------------------------------------------------------------------
// Per-ticket ledger + failure classification
// ---------------------------------------------------------------------------
const ledger = {};   // ticket number -> { attempts, state, runId, lastError }
function ledgerFor(num) {
  if (!ledger[num]) ledger[num] = { attempts: 0, state: "pending", runId: null, lastError: null };
  return ledger[num];
}

function classifyFailure(result) {
  if (!result) return "unknown";
  if (result.ok) return "ok";
  const err = String(result.error || "");
  if (/timed?\s?out|timeout|deadline/i.test(err)) return "timeout";
  // A single flaky e2e test failure must not abort the
  // whole workflow. Classify it explicitly so the ladder can re-run the
  // gate (quarantine/recheck) instead of paying for a full code fixer.
  if (FLAKE_RE.test(err)) return "flake";
  if (/gate/i.test(err)) return "gate";
  return "unknown";
}

// Flake quarantine step: re-run the failing test ONCE in the *retained*
// worktree of the run whose gate failed — the only tree that still holds that
// child's uncommitted work. If it passes, the failure was transient and the
// merge proceeds on the preserved patch.
//
// Deliberately NOT `worktree: true`: a fresh tree branched from the integration
// branch would not contain the partial work, so a pass there would prove
// nothing about the patch. There is no typed gate either (the harness is not
// tracking the tree the child works in), so the script parses the reported
// label and the merge gate re-verifies the work for real afterwards.
function spawnFlakeRecheck(ticket, priorResult, wave) {
  const key = "flake-recheck-" + wave + "-t" + keyOf(ticket.ref);
  const runId = priorResult && priorResult.runId;
  const task = [
    "The verification gate for ticket " + ticket.ref + " failed once, in run " +
      (runId || "unknown") + ". That looks like a LIKELY FLAKE (a single",
    "transient-looking test failure), not a real defect. Prove it either way.",
    "",
    "Your ONLY job: re-run the failing test in the worktree that run left",
    "behind. Change nothing.",
    "",
    "1. Find that worktree — do not assume where worktrees live: from the repo",
    "   checkout run `git worktree list --porcelain` and take the entry whose",
    "   path contains the run id above (managed worktrees are named",
    "   pi-worktree-<runId>-<index> under the configured base). If nothing",
    "   matches, report 'WORKTREE_NOT_FOUND' and stop.",
    "2. cd into it, confirm `git status` shows that run's uncommitted changes,",
    "   and identify the failing test from the gate output.",
    "3. In THAT tree, run ONLY that test: " + (RETEST_COMMAND
      ? RETEST_COMMAND + " — substitute the failing test's own path/name."
      : "use the single-test command this repo documents (docs/agents/verification.md)."),
    "4. If it passes, report the exact test path and 'FLAKE_CONFIRMED_TRANSIENT'.",
    "5. If it fails again, report 'FLAKE_PERSISTENT' and the failure detail.",
    "",
    "Do NOT modify any files. Do NOT run the full suite. Do NOT commit, create",
    "branches or worktrees, or spawn subagents.",
    "",
    "Return ONLY the test result and one of the labels above."
  ].join("\n");
  return runs.run(key, {
    label: "Flake recheck ticket " + ticket.ref + " (in the failed run's worktree)",
    agent: AG.implementer,
    task: task,
    timeoutMs: 15 * 60 * 1000
  });
}

// Because the tracker is the source of truth and can be updated by 
// implementers (status flips) and mergers (patch application), we must
// refresh the graph when a ticket may have changed, but not on every single
// wave start. We cache the last-read result and only force a re-fetch after
// a merger commits changes to the
// integration branch.
let ticketGraphCache = null;
// An unreadable ticket silently drops out of this wave's frontier, so report
// it instead of dropping it.
function scoutLints(result) {
  const text = String((result && result.output) || "");
  const unreadable = text.match(/UNREADABLE:\s*\S+/g) || [];
  unreadable.forEach(function(u) {
    emit("ticket-graph: " + u + ": ticket unreadable this wave");
  });
}
function getTicketGraph(forceDiscovery) {
  if (ticketGraphCache && !forceDiscovery) {
    emit("ticket graph: reused cached discovery (ticketsRef unchanged since last read)");
    return Promise.resolve(ticketGraphCache);
  }
  return readTicketGraph().then(function(result) {
    scoutLints(result);
    ticketGraphCache = result;
    return result;
  });
}

// The continue-child reports its retained worktree as the final line:
// WORKTREE_PATH: /absolute/path
function extractWorktreePath(output) {
  const text = String(output || "");
  const m = text.match(/WORKTREE_PATH:\s*(\S+)/);
  return m ? m[1] : null;
}

// Structured escalation: the lead (not the script) decides what happens next.
function escalate(ref, reason, detail) {
  emit("ESCALATION: ticket " + ref + " — " + reason +
       (detail ? " | detail: " + detail : "") +
       " | Lead decision needed: resume/fix/park this ticket. Dependents are waiting.");
}

// ---------------------------------------------------------------------------
// Main flow — top-level awaits only.
// ---------------------------------------------------------------------------

// Wave 0: discover the ticket graph from the tracker (#10: this is the only
// point where we force a fresh read; later waves re-use the cache).
const graphRun = await getTicketGraph(true);
const graphOk = !!(graphRun && graphRun.ok);
const tickets = statusesFromGraph(graphRun);
if (!tickets.length) {
  return {
    ok: false,
    error: "ticket discovery found no tickets for " + ticketsRef
      + (graphOk ? "" : " (the discovery run itself failed)")
      + ". Check the target against docs/agents/issue-tracker.md and relaunch.",
    discoveryRunId: graphRun && graphRun.runId
  };
}

// Wave 0 preflight: a tracker must be configured and the integration branch
// must already exist. Without these, the run either has nothing to read or
// every implementer dies on an unresolvable baseRef.
const preflight = preflightFromGraph(graphRun);
if (preflight && preflight.trackerConfigured === false) {
  return {
    ok: false,
    error: "no usable issue tracker is configured. Run /setup-matt-pocock-skills, " +
      "then relaunch. The tracker is recorded in docs/agents/issue-tracker.md.",
    preflight: preflight,
    discoveredTickets: tickets.length
  };
}
if (preflight && preflight.integrationBranchExists === false) {
  return {
    ok: false,
    error: "integration branch '" + integrationBranch + "' does not resolve (" + baseRef + "). " +
      "Branch it from " + BASE_BRANCH + " first, or pass the name this repo actually uses " +
      "(docs/agents/verification.md records the convention).",
    preflight: preflight,
    discoveredTickets: tickets.length
  };
}
if (!preflight) {
  emit("implement-spec: discovery reported no preflight; cannot confirm " + baseRef +
       " resolves before wave 1. Implementers will fail on baseRef if it does not exist.");
}

// Normalize + index. Script-side ledger of what has been merged.
const byRef = {};
const order = [];
for (const t of tickets) {
  const ref = (t.ref === undefined || t.ref === null) ? "" : String(t.ref);
  if (!ref) continue;
  if (!byRef[ref]) { order.push(ref); }
  byRef[ref] = {
    ref: ref,
    title: t.title || ("ticket " + ref),
    resolved: !!t.resolved,
    blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : []
  };
}
emit("implement-spec: discovered " + order.length + " tickets: " + order.join(", "));

const merged = [];        // ticket refs implemented AND merged
const escalated = [];     // tickets given up to the lead after maxRemediations
const waveReports = [];
let totalRemediations = 0;
let waveCount = 0;        // survives the wave loop for the closing sequence

if (verifyOnly) {
  // Resume mode: no implementation. Treat whatever the tracker marks resolved
  // as the merged set, then run only the closing sequence.
  const st0 = statusesFromGraph(graphRun);
  for (const s of st0) {
    const ref = (s.ref === undefined || s.ref === null) ? "" : String(s.ref);
    if (!ref) continue;
    if (s.resolved) {
      merged.push(ref);
      ledgerFor(ref).state = "merged";
    } else {
      ledgerFor(ref).state = "unresolved";
    }
  }
  emit("verifyOnly: " + merged.length + " tickets already resolved; skipping implementation waves");
} else {
  let wave = 0;
  let stallGuard = 0;
  while (wave < maxWaves) {
    wave = wave + 1;

    // Re-read ticket state from the tracker every wave. The tracker is the
    // source of truth, not child claims.
    // Use the cached graph unless a merge may have changed
    // ticket state on the integration branch.
    const statusRun = await getTicketGraph(false);
    const statuses = statusesFromGraph(statusRun);
    const resolvedByRef = {};
    for (const s of statuses) {
      const ref = (s.ref === undefined || s.ref === null) ? "" : String(s.ref);
      if (ref) resolvedByRef[ref] = !!s.resolved;
    }

    // Frontier: unresolved, not merged, not escalated, all blockers merged.
    const frontier = [];
    for (const ref of order) {
      const t = byRef[ref];
      const ld = ledgerFor(ref);
      if (ld.state === "merged" || ld.state === "escalated") continue;
      if (resolvedByRef[ref]) {
        ld.state = "merged";
        merged.push(ref);
        continue;
      }
      const blockerOpen = t.blockedBy.some(function(b) {
        return ledgerFor(b).state !== "merged";
      });
      if (blockerOpen) continue;
      frontier.push(t);
    }

    if (!frontier.length) break;

    const batch = frontier.slice(0, maxParallel);
    emit("wave " + wave + ": implementing tickets " +
         batch.map(function(t) { return t.ref; }).join(", "));

    // Fan out implementers. If runs.all rejects (any single child failure),
    // fall back to SERIAL spawns so one failure cannot lose its siblings'
    // completed work — the pre-ladder failure mode.
    let implResults = null;
    // A transient sandbox or transport error should not abort the whole
    // fan-out. If the first parallel attempt fails, we retry ONCE; if that
    // also fails, we fall back to serial spawns (preserving sibling work).
    function tryRunAll() {
      return runs.all(batch.map(function(ticket) {
        return spawnImplementer(ticket, wave);
      }));
    }
    try {
      implResults = await tryRunAll();
    } catch (e) {
      emit("wave " + wave + ": runs.all rejected (" + e + "); retrying once before serial fallback");
      try {
        implResults = await tryRunAll();
      } catch (eRetry) {
        emit("wave " + wave + ": retry rejected (" + eRetry + "); falling back to serial spawns");
        implResults = [];
        for (const t of batch) {
          try {
            implResults.push(await spawnImplementer(t, wave));
          } catch (e2) {
            emit("wave " + wave + ": serial spawn for ticket " + t.number + " rejected (" + e2 + ")");
            implResults.push({ ok: false, error: String(e2) });
          }
        }
      }
    }

    // Per-ticket remediation ladder + serial merges.
    let progressThisWave = 0;
    let remediationsThisWave = 0;
    for (let i = 0; i < batch.length; i++) {
      const ticket = batch[i];
      const ld = ledgerFor(ticket.ref);
      let implResult = implResults ? implResults[i] : null;
      const cls = classifyFailure(implResult);
      ld.runId = implResult && implResult.runId ? implResult.runId : ld.runId;

      if (cls !== "ok") {
        ld.attempts = ld.attempts + 1;
        ld.lastError = (implResult && implResult.error) || cls;
        remediationsThisWave = remediationsThisWave + 1;
        totalRemediations = totalRemediations + 1;
        emit("ticket " + ticket.ref + ": " + cls + " failure — remediation attempt " +
             ld.attempts + "/" + MAX_REMEDIATIONS);

        if (ld.attempts > MAX_REMEDIATIONS) {
          escalate(ticket.ref, "exhausted " + MAX_REMEDIATIONS + " remediation attempts (" + cls + ")",
                   "runId=" + ld.runId + " lastError=" + ld.lastError);
          ld.state = "escalated";
          escalated.push(ticket.ref);
          continue;
        }

        let remediated = null;
        if (cls === "timeout") {
          // Tier 1: resume the same child/session/worktree when possible.
          remediated = await tryResume(ld.runId, ticket.ref, wave);
          // Tier 2: a continue-child that finishes the retained worktree.
          if (!remediated) {
            try {
              remediated = await spawnContinueChild(ticket, ld.runId, wave);
            } catch (eC) {
              emit("ticket " + ticket.ref + ": continue-child rejected (" + eC + ")");
            }
          }
          if (remediated && remediated.ok) {
            const wt = extractWorktreePath(remediated.output);
            if (wt) {
              ld.worktreePath = wt;
              emit("ticket " + ticket.ref + ": continue-child reported worktree " + wt);
            } else {
              emit("ticket " + ticket.ref + ": continue-child gave no WORKTREE_PATH; merger falls back to manifest");
            }
          }
        } else if (cls === "flake") {
          // Re-run the single failing test once before paying for a full code fixer.
          emit("ticket " + ticket.ref + ": flake detected — running quarantine recheck before fixer");
          try {
            const flakeResult = await spawnFlakeRecheck(ticket, implResult, wave);
            if (flakeResult && flakeResult.ok && /FLAKE_CONFIRMED_TRANSIENT/i.test(String(flakeResult.output || ""))) {
              emit("ticket " + ticket.ref + ": flake confirmed transient — proceeding to merge on the preserved work");
              // implResult.ok is false — that is why we are in this branch — so
              // handing it back as the "remediation" would fail the ok check
              // below and escalate a ticket whose failure was just proven
              // transient. Carry the original run's id, output and captured
              // patch forward as a pass-through; the merge gate is what actually
              // verifies this work on the integration branch.
              remediated = {
                ok: true,
                error: null,
                runId: implResult && implResult.runId,
                output: implResult && implResult.output,
                artifactPaths: implResult && implResult.artifactPaths,
                flakeQuarantined: true
              };
              ld.flakeQuarantined = true;
            } else {
              emit("ticket " + ticket.ref + ": flake persistent or recheck failed — escalating to fixer");
              remediated = await spawnFixer(ticket, implResult, wave);
            }
          } catch (eR) {
            emit("ticket " + ticket.ref + ": flake recheck rejected (" + eR + ")");
          }
        } else {
          // Gate or unknown failure: fixer child repairs the captured patch.
          try {
            remediated = await spawnFixer(ticket, implResult, wave);
          } catch (eF) {
            emit("ticket " + ticket.ref + ": fixer rejected (" + eF + ")");
          }
        }

        if (remediated && remediated.ok) {
          implResult = remediated;
          ld.runId = remediated.runId ? remediated.runId : ld.runId;
          emit("ticket " + ticket.ref + ": remediation succeeded");
        } else {
          escalate(ticket.ref, cls + " remediation failed",
                   "runId=" + ld.runId + " lastError=" + ((remediated && remediated.error) || ld.lastError));
          ld.state = "escalated";
          escalated.push(ticket.ref);
          continue;
        }
      }

      // Merge — serial, one integration checkout at a time, one retry.
      let mergeRun = null;
      let mergeErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          mergeRun = await spawnMerger(ticket, implResult, wave, ld.worktreePath || null);
        } catch (e2) {
          mergeErr = String(e2);
          emit("ticket " + ticket.ref + ": merger run rejected (" + e2 + ")");
        }
        if (mergeRun && mergeRun.ok) break;
        if (attempt === 0) emit("ticket " + ticket.ref + ": merge failed; one idempotent merger retry");
      }
      if (mergeRun && mergeRun.ok) {
        ld.state = "merged";
        merged.push(ticket.ref);
        progressThisWave = progressThisWave + 1;
        emit("ticket " + ticket.ref + ": merged into " + integrationBranch);
      } else {
        escalate(ticket.ref, "merge failed after retry", mergeErr ||
                 ((mergeRun && mergeRun.error) || "unknown"));
        ld.state = "escalated";
        escalated.push(ticket.ref);
      }
    }

    waveReports.push({
      wave: wave,
      attempted: batch.map(function(t) { return t.number; }),
      mergedThisWave: progressThisWave,
      remediationsThisWave: remediationsThisWave
    });
    waveCount = wave;

    // The tracker is the source of truth, and a merge may have updated ticket
    // state. Drop the cached graph so the next wave re-discovers it. Without
    // this the whole run would reuse wave 0's discovery and the invariant above
    // would be a comment, not behaviour. Costs one quiet read-only scout per
    // active wave.
    if (progressThisWave > 0) ticketGraphCache = null;

    if (progressThisWave === 0) {
      stallGuard = stallGuard + 1;
      if (stallGuard >= 2) {
        emit("implement-spec: no merge progress for 2 consecutive waves; stopping");
        break;
      }
    } else {
      stallGuard = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Closing sequence — final verify, three-axis review, fix pass, PR.
// ---------------------------------------------------------------------------
let reviews = null;
let reviewsIncomplete = false;
let fixRun = null;
let fixMergerRun = null;
let prRun = null;

if (merged.length) {
  // Final verification: full suite (including e2e) on the integrated branch.
  let verifyRun = null;
  try {
    verifyRun = await runs.run("final-verify", {
      label: "Final full-suite verification",
      agent: AG.merger,
      task: [
        "Final verification pass on branch " + integrationBranch + " in this checkout.",
        "First confirm that branch resolves. If it does not, change nothing, run",
        "nothing, and reply 'MISSING_TARGET' with what you checked — do NOT",
        "substitute another branch or treat the current checkout as the target.",
        "Run the FULL test suite with: " + FULL_GATE,
        "If anything fails, investigate and fix directly (no subagents), then",
        "re-run until green, committing any fix. Return the test runner's summary line."
      ].join("\n"),
      timeoutMs: MERGE_TIMEOUT_MS,
      gate: gateObj(FULL_GATE)
    });
  } catch (eV) {
    emit("implement-spec: final-verify rejected (" + eV + ")");
  }
  if (!verifyRun || !verifyRun.ok) {
    emit("implement-spec: final full-suite verification FAILED");
  }

  let reviewResults = null;
  try {
    reviewResults = await spawnReviews(waveCount);
  } catch (e3) {
    emit("implement-spec: review fan-out rejected (" + e3 + "); proceeding without reviews");
    reviewResults = [];
  }
  reviews = reviewResults.map(function(r, i) {
    const axes = ["standards", "spec", "quality"];
    const out = r && r.output ? String(r.output) : "";
    // A missing verdict is NOT a pass. Previously an axis that failed outright,
    // or a reviewer that reported findings without the contract line, was
    // scored "OK" and the run sailed straight into the PR.
    let verdict;
    if (!r || !r.ok) verdict = "UNVERDICTED";
    else if (out.indexOf("Review verdict: BLOCK") >= 0) verdict = "BLOCK";
    else if (out.indexOf("Review verdict: OK") >= 0) verdict = "OK";
    else if (out.indexOf("Review verdict: MISSING_TARGET") >= 0) verdict = "MISSING_TARGET";
    else verdict = "UNVERDICTED";
    return {
      axis: axes[i] || ("axis" + i),
      ok: !!(r && r.ok),
      verdict: verdict,
      excerpt: out.slice(0, 400)
    };
  });
  const blockedAxes = reviews.filter(function(r) { return r.verdict === "BLOCK"; });
  // Incomplete review = fewer than three axes came back, or any axis returned
  // without a verdict, or refused because its target was missing. That is not a
  // green light; it is an unknown.
  const unreviewedAxes = reviews.filter(function(r) { return r.verdict !== "BLOCK" && r.verdict !== "OK"; });
  reviewsIncomplete = reviews.length < 3 || unreviewedAxes.length > 0;
  if (reviewsIncomplete) {
    const detail = unreviewedAxes.map(function(r) { return r.axis + ":" + r.verdict; });
    emit("ESCALATION: review is INCOMPLETE" +
         (detail.length ? " — axes without a verdict: " + detail.join(", ")
                        : " — only " + reviews.length + " of 3 axes returned") +
         ". An axis with no 'Review verdict:' line is not a pass. PR suppressed; Lead decision needed: re-run the review or accept the gap explicitly.");
  }

  if (blockedAxes.length) {
    // Fix pass: worktree-isolated so the main checkout stays clean, then a
    // dedicated merger commits the fixes BEFORE the PR
    const fixBrief = [
      "Reviewers BLOCKED the integrated work on branch " + integrationBranch + ".",
      "Findings (excerpts):",
      JSON.stringify(blockedAxes, null, 2),
      "",
      "Fix the must-fix defects in YOUR managed worktree (already branched from",
      integrationBranch + "), keep the gate green (" + FULL_GATE + "), and do NOT",
      "commit — the orchestrator captures and merges your patch. Do NOT spawn",
      "subagents. End with the acceptance-report block."
    ].join("\n");
    try {
      fixRun = await runs.run("fix-review-findings", {
        label: "Fix review blockers (worktree-isolated)",
        agent: AG.implementer,
        task: fixBrief,
        worktree: true,
        baseRef: baseRef,
        timeoutMs: IMPL_TIMEOUT_MS,
        gate: gateObj(FULL_GATE)
      });
    } catch (eFx) {
      emit("implement-spec: fix-review-findings rejected (" + eFx + ")");
    }

    if (fixRun && fixRun.ok) {
      try {
        fixMergerRun = await runs.run("merge-review-fixes", {
          label: "Commit and merge review fixes into " + integrationBranch,
          agent: AG.merger,
          task: [
            "Merge the review-fix implementer's captured patch into " + integrationBranch + ".",
            "",
            "The fixer ran in a managed worktree; its patch is in its handoff",
            "manifest. Candidate manifest/artifact paths:",
            ((fixRun.artifactPaths || []).join(" ") || "(inspect handoffs/ under the session artifact dir)"),
            "",
            "Steps:",
            "1. Confirm the main checkout is on " + integrationBranch + " and clean.",
            "2. Locate and apply the captured patch (git apply --index <patch>).",
            "3. Commit: git commit -m \"Address review findings\"",
            "4. Re-run the full gate yourself: " + FULL_GATE,
            "5. Return: merge status, commit hash, gate result."
          ].join("\n"),
          timeoutMs: MERGE_TIMEOUT_MS,
          gate: gateObj(FULL_GATE)
        });
      } catch (eM) {
        emit("implement-spec: merge-review-fixes rejected (" + eM + ")");
      }
      if (!fixMergerRun || !fixMergerRun.ok) {
        emit("ESCALATION: review fixes were produced but NOT merged into " +
             integrationBranch + " — the fixer's worktree holds uncommitted work. " +
             "Lead decision needed before any PR.");
      }
    } else {
      emit("ESCALATION: review fix pass failed or was rejected — lead decision needed before any PR.");
    }
  }

  // PR only when the tree is in a known-good state: the review actually
  // completed, and there are either no blockers or blockers fixed AND merged.
  // Never open a PR from a pre-fix commit, or from an unknown review state.
  const fixesClean = (!blockedAxes.length || (fixRun && fixRun.ok && fixMergerRun && fixMergerRun.ok)) && !reviewsIncomplete;
  if (!skipPR && fixesClean) {
    try {
      prRun = await runs.run("pr", {
        label: "Open pull/merge request",
        agent: AG.prWriter,
        task: [
          PR_INSTRUCTIONS
            ? PR_INSTRUCTIONS
            : "Open this repo's pull/merge request for the integrated work, using the\n" +
              "command recorded in docs/agents/verification.md and the issue tracker doc.",
          "Branch: " + integrationBranch + " -> " + BASE_BRANCH + ", covering tickets " +
            merged.join(", ") + " (spec: " + specPath + ").",
          "The tickets at " + ticketsRef + " hold the per-ticket answers.",
          "If this repo has no request surface, commit the integration branch and say so."
        ].join("\n"),
        timeoutMs: MERGE_TIMEOUT_MS
      });
    } catch (eP) {
      emit("implement-spec: pr run rejected (" + eP + ")");
    }
  } else if (!skipPR) {
    emit("implement-spec: PR suppressed — " +
         (reviewsIncomplete ? "review incomplete" : "review fixes not cleanly merged") +
         "; lead decision needed");
  }
}

const unresolved = order.filter(function(num) {
  return merged.indexOf(num) < 0 && escalated.indexOf(num) < 0;
});

return {
  ok: escalated.length === 0 && unresolved.length === 0 && !reviewsIncomplete,
  integrationBranch: integrationBranch,
  waves: waveReports.length,
  merged: merged,
  escalated: escalated,
  unresolved: unresolved,
  waveReports: waveReports,
  totalRemediations: totalRemediations,
  ledger: ledger,
  reviews: reviews,
  reviewsIncomplete: reviewsIncomplete,
  fixApplied: !!(fixRun && fixRun.ok),
  fixMerged: !!(fixMergerRun && fixMergerRun.ok),
  prCreated: !!(prRun && prRun.ok),
  prOutput: prRun && prRun.output ? prRun.output.slice(0, 400) : null
};
