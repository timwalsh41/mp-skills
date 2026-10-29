// implement-spec Orchestration Workflow (remediation-ladder rewrite, 2026-10-15)
//
// Runs INSIDE the pi subagent workflow sandbox. That sandbox is a plain JS
// statement body with top-level await and NO fs/shell/require/tools — every
// action on the world goes through child agents via runs.run / runs.all.
//
// Some helpers below (numArg, boolArg, gateObj, childControl, checkoutHint,
// reviewAxisTask, parseReviewVerdict, parseVerification, classifyFailure) are
// shared with implement/orchestrate.js — the /implement workflow inlines its
// own copies, because the Pi workflow sandbox has no import/require mechanism.
// If Pi adds module support to the workflow sandbox, these should be extracted
// into a single importable module to avoid drift.
// Contract with the invoking lead agent:
//   subagent({ workflow: "./.agents/skills/implement-spec/orchestrate.js",
//              args: { ... }, async: true })
//
// args (plain JSON, <=16KiB). REPO-SPECIFIC VALUES ARE PASSED IN, NEVER
// GUESSED: the lead resolves them from docs/agents/issue-tracker.md (where the
// spec and tickets live, how work closes) and docs/agents/verification.md
// (check commands, base branch, PR surface). This script has no filesystem
// access, so it carries no project defaults and fails fast on missing ones.
//   specRef            REQUIRED  the spec, as a REFERENCE: either a path in
//                      the repo (e.g. ".scratch/<feature-slug>/spec.md") or
//                      the tracker ticket/epic that holds it (e.g.
//                      "JRB-001 (epic)"). specPath is accepted as an alias.
//                      The script only interpolates it into child task text,
//                      so either form works — but a tracker-held spec is
//                      read by the children from the tracker, never from a
//                      file in their worktree.
//   ticketsRef         REQUIRED  e.g. ".scratch/<feature-slug>/issues"
//   integrationBranch  REQUIRED  named branch only, e.g. "<feature-slug>-integration"
//   fullGate           REQUIRED  the repo's full-suite command
//   narrowGate         default = fullGate; the repo's fast subset
//   maxParallel        default 4     concurrent implementer worktrees
//   maxWaves           default 6     frontier re-scan rounds
//   skipPR             default false
//   finalizeMergedPR   default false. Confirm the integration merge and apply
//                      Complete transitions only; does not implement or open a PR.
//   prUrl / mergeRef   evidence locator required by finalizeMergedPR
//   prWaiverReason    explicit user waiver of completed review blockers only
//   transitionCommands optional per-phase command overrides; default actions
//                      are read from docs/agents/issue-tracker.md
//   verifyOnly         default false. Skip implementation entirely and run
//                      the closing sequence over ticket work already on the
//                      integration branch, regardless of whether the issue's
//                      lifecycle status is Complete yet. Resume mode.
//   fullGateTickets    default null = every ticket gates on the FULL suite.
//                      When only some tickets own the slow tier (browser tests,
//                      a service that must be running), pass e.g. [15]: those
//                      gate FULL, the rest gate NARROW so a tier that cannot
//                      pass yet cannot falsely fail every other run.
//   gateTimeoutMs      default 15 min — harness gate caps are shorter than most
//                      real suites; take this number from the verification doc
//   implTimeoutMs      default 75 min per implementer/fixer/continue child
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
//                      reviewerStandards, reviewerSpec, reviewerQuality,
//                      verifier } for projects whose agent definitions use
//                      other names
//   trackerHint        optional. A short pointer to the tracker's read,
//                      update, grooming, and lifecycle operations. The issue
//                      tracker doc remains the source of truth; this pointer
//                      helps a child whose worktree does not carry that doc.
//   repoPath           optional. The absolute path of the checkout this run
//                      integrates into. Children that work in the MAIN
//                      checkout (merger, verifier, final verify, review axes,
//                      request writer) are told where it is and told to
//                      confirm their own working directory before they
//                      conclude that a branch, a spec or a file is missing:
//                      a child that lands in the wrong directory otherwise
//                      reports a missing target, which suppresses the
//                      request and escalates a run that is actually fine.
//   implTimeoutMs      default 75 min per implementer/fixer/continue child
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
//   - Issue state is re-read from the tracker every wave by a scout child;
//     ticket commits already on the integration branch are verified regardless
//     of whether the tracker lifecycle is still In Progress or Ready for Review.
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
// The spec is a reference, not necessarily a file: a path in the repo, or the
// tracker ticket/epic that holds it. specPath is the older name, still
// accepted.
const specRef = A.specRef || A.specPath || null;
const ticketsRef = A.ticketsRef || null;
const integrationBranch = A.integrationBranch || null;
const FULL_GATE = A.fullGate || null;
const finalizeMergedPR = boolArg(A.finalizeMergedPR);

// Args arrive exactly as the caller wrote them. A caller that quotes a
// number ("900000") hands the harness a string, and the harness then rejects
// the gate with "gate.timeoutMs must be an integer >= 1" — for EVERY ticket
// in the run, while looking exactly like a broken implementation. Coerce
// once, here, and never trust the caller's types.
function numArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}
function boolArg(value) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

// Repo-specific args have no fallback: running a gate that does not exist in
// this repo burns a remediation cycle per ticket, and merging into a branch
// nobody named is worse. Bail before any child launches.
const missingArgs = [];
if (!specRef) missingArgs.push("specRef");
if (!ticketsRef) missingArgs.push("ticketsRef");
if (!integrationBranch) missingArgs.push("integrationBranch");
if (!finalizeMergedPR && !FULL_GATE) missingArgs.push("fullGate");
if (finalizeMergedPR && !(A.prUrl || A.mergeRef)) missingArgs.push("prUrl or mergeRef for post-merge confirmation");
if (missingArgs.length) {
  return {
    ok: false,
    error: "implement-spec is missing required args: " + missingArgs.join(", ") +
      ". Resolve them from docs/agents/verification.md (gates, branches) and " +
      "docs/agents/issue-tracker.md (spec + ticket locations) and relaunch."
  };
}

const maxParallel = numArg(A.maxParallel, 4);
const maxWaves = numArg(A.maxWaves, 6);
const skipPR = boolArg(A.skipPR);
const verifyOnly = boolArg(A.verifyOnly);
const baseRef = "refs/heads/" + integrationBranch;
const BASE_BRANCH = A.baseBranch || "main";
const PR_INSTRUCTIONS = A.prInstructions || null;
const PR_WAIVER_REASON = typeof A.prWaiverReason === "string" ? A.prWaiverReason.trim() : "";
const STANDARDS_DOCS = A.standardsDocs ||
  "the files this repo documents as coding standards (search for CODING_STANDARDS.md, CONTRIBUTING.md, and anything AGENTS.md points at)";
const RETEST_COMMAND = A.singleRetestCommand || null;
const TRACKER_HINT = A.trackerHint || null;
const REPO_PATH = A.repoPath || null;
// Explicit commands remain an override. By default, each lifecycle action is
// resolved from the target repository's docs/agents/issue-tracker.md.
const TRANSITION_COMMANDS = A.transitionCommands || null;
function runTransition(phase, ref, variables) {
  const command = TRANSITION_COMMANDS && TRANSITION_COMMANDS[phase];
  const task = command
    ? "Run this tracker transition command for issue " + ref + ":\n" +
      command
        .replace(/\$TICKET_REF/g, String(ref))
        .replace(/\$BRANCH/g, String(variables.branch || ""))
        .replace(/\$PR_URL/g, String(variables.prUrl || ""))
    : [
        "Read docs/agents/issue-tracker.md in " + (REPO_PATH || "the target repository") +
          " and follow its lifecycle workflow for this issue.",
        "If tracker-specific operations are absent from the current worktree, use this pointer:",
        TRACKER_HINT || "No tracker hint was supplied; inspect the configured issue tracker documentation.",
        "Phase: " + phase,
        "Issue: " + ref,
        "Branch: " + String(variables.branch || ""),
        "PR URL: " + String(variables.prUrl || ""),
        "Use the documented transition only. If the tracker explicitly has no such lifecycle transition, report TRANSITION_UNSUPPORTED without changing state.",
        "Otherwise report exactly TRANSITION_APPLIED, TRANSITION_ALREADY_SET, or TRANSITION_FAILED, with the resulting status and any error.",
        "Do not modify code, other issues, or repository files."
      ].join("\n");
  return runs.run("transition-" + phase + "-" + keyOf(ref), {
    agent: AG.worker,
    label: "Transition " + ref + " to " + phase,
    task: task + "\nReport the HTTP status code or error. Change nothing else.",
    timeoutMs: 60 * 1000,
    quiet: true
  }).then(function(r) {
    const output = String((r && r.output) || "");
    const unsupported = output.indexOf("TRANSITION_UNSUPPORTED") >= 0;
    const ok = !!(r && r.ok) && (unsupported || !/TRANSITION_FAILED|TRACKER_DOC_MISSING|TRANSITION_UNCLEAR/.test(output));
    emit("implement-spec: transition " + phase + " for " + ref + " -- " + (unsupported ? "unsupported by tracker" : (ok ? "done" : "failed")));
    return { ok: ok, output: output, unsupported: unsupported };
  });
}
function parsePrWriterResult(result) {
  const output = String((result && result.output) || "");
  const match = output.match(/(?:^|\n)PR_CREATED:\s*(https?:\/\/[^\s]+)/);
  return {
    url: match ? match[1] : null,
    noPrSurface: /(?:^|\n)NO_PR_SURFACE(?:\n|$)/.test(output)
  };
}
function confirmMerged(refs, mergeRef) {
  return runs.run("confirm-merge", {
    agent: AG.worker,
    label: "Confirm merged issue work",
    task: [
      "Read docs/agents/issue-tracker.md and docs/agents/verification.md in " + (REPO_PATH || "the target repository") + ".",
      "Confirm using the documented merge/request process that the merge reference is complete and includes the work for every listed issue. The integration branch may have been deleted after merge.",
      "Issues: " + refs.join(", "),
      "Integration branch: " + integrationBranch,
      "Merge or PR reference: " + mergeRef,
      "Do not change issue statuses. Report exactly MERGED_CONFIRMED or MERGE_NOT_CONFIRMED, with evidence."
    ].join("\n"),
    timeoutMs: 60 * 1000,
    quiet: true
  });
}

// Tracker-specific issue fields and lifecycle operations come from
// docs/agents/issue-tracker.md, never from hard-coded Markdown assumptions.
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
  reviewerQuality: ROLES.reviewerQuality || "reviewer-quality",
  verifier: ROLES.verifier || "verifier",
  // Lightweight git operator for setup tasks (branch creation, transitions).
  worker: ROLES.worker || "worker"
};
// Review axis configuration, used by spawnReviews and the UNVERDICTED retry logic.
const REVIEW_AXES = [
  { name: "standards", agent: AG.reviewerStandards, focus: "conformance to " + STANDARDS_DOCS + ", plus the repo's conventions" },
  { name: "spec", agent: AG.reviewerSpec, focus: "does the integrated work satisfy the spec and ticket acceptance criteria" },
  { name: "quality", agent: AG.reviewerQuality, focus: "correctness, robustness, test coverage, maintainability" }
];

const IMPL_TIMEOUT_MS = numArg(A.implTimeoutMs, 75 * 60 * 1000);
const MERGE_TIMEOUT_MS = numArg(A.mergeTimeoutMs, 20 * 60 * 1000);
// The harness default gate cap is 120s, under the real
// suite runtime. EVERY gate must carry an explicit generous deadline — so
// children get the launch object, never a bare command string.
const GATE_TIMEOUT_MS = numArg(A.gateTimeoutMs, 15 * 60 * 1000);
const MAX_REMEDIATIONS = numArg(A.maxRemediations, 2);
const MAX_REVIEW_RETRIES = numArg(A.maxReviewRetries, 2);

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

// The checkout the run integrates into. A child's working directory is not
// guaranteed to be it — a workflow child can be launched with a directory
// resolved from somewhere else entirely — and a child in the wrong directory
// will happily report that the branch, the spec or the ticket file is
// missing. That is a missing TARGET verdict, which suppresses the request
// and escalates a run that is actually fine. So every child that works in
// the main checkout is told where it is, and told to confirm its own
// working directory before it calls anything missing.
function checkoutHint() {
  if (!REPO_PATH) {
    return [
      "Before you conclude that anything is missing, confirm you are in the",
      "right checkout: run `git rev-parse --show-toplevel` and check it is the",
      "repository this run is integrating into. A child launched in the wrong",
      "directory sees no branch, no spec and no ticket — that is a wrong",
      "directory, not a missing target."
    ];
  }
  return [
    "The checkout to work in: " + REPO_PATH,
    "Your working directory may not be that checkout. Start with:",
    "  git -C " + REPO_PATH + " rev-parse --show-toplevel",
    "and work in " + REPO_PATH + " (cd there) before you conclude that any",
    "branch, spec or file is missing — a child in the wrong directory sees",
    "none of them, and that is a wrong directory, not a missing target."
  ];
}

// The harness raises a "needs attention" notice after 60s of silence and
// wakes the parent to deal with it. A child running a verification gate is
// silent BY DESIGN for as long as the gate takes, so every gated child used
// to trigger a notice that looked like a stall — the parent then had to go
// and prove the child was fine, once per ticket per wave.
//
// Give every child this workflow spawns a silence window longer than its
// gate, and stop the harness pushing control notices for them: the child's
// own completion notice is the signal that matters. The control event still
// updates the child's state (visible on demand via status), it just no
// longer interrupts the lead.
const CONTROL_SILENCE_MARGIN_MS = 2 * 60 * 1000;
function childControl() {
  return {
    needsAttentionAfterMs: GATE_TIMEOUT_MS + CONTROL_SILENCE_MARGIN_MS,
    notifyOn: []
  };
}

// ---------------------------------------------------------------------------
// Config preflight — a malformed arg is a CONFIG error, not a ticket
// failure. Left to the remediation ladder it gets laundered into a bogus
// fixer, a bogus escalation and a dead run: the first observed case was a
// quoted "900000" gate timeout, which the harness rejects for every ticket
// in the run while looking exactly like a broken implementation. Fail once,
// loudly, before any child launches.
// ---------------------------------------------------------------------------
const configErrors = [];
function describeArg(value) {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}
function requireInt(value, name, min) {
  if (!Number.isInteger(value)) {
    configErrors.push(name + " must be an integer (got " + describeArg(value) + ")");
  } else if (value < min) {
    configErrors.push(name + " must be >= " + min + " (got " + value + ")");
  }
}
requireInt(maxParallel, "maxParallel", 1);
requireInt(maxWaves, "maxWaves", 1);
requireInt(GATE_TIMEOUT_MS, "gateTimeoutMs", 1000);
requireInt(IMPL_TIMEOUT_MS, "implTimeoutMs", 1000);
requireInt(MERGE_TIMEOUT_MS, "mergeTimeoutMs", 1000);
requireInt(MAX_REMEDIATIONS, "maxRemediations", 0);
requireInt(MAX_REVIEW_RETRIES, "maxReviewRetries", 0);
if (fullGateTickets !== null && fullGateTickets !== undefined) {
  if (!Array.isArray(fullGateTickets)) {
    configErrors.push("fullGateTickets must be an array of ticket refs");
  } else if (fullGateTickets.some(function(t) { return typeof t !== "string"; })) {
    configErrors.push("fullGateTickets must contain ticket ref strings");
  }
}
if (configErrors.length) {
  return {
    ok: false,
    error: "implement-spec config error: " + configErrors.join("; ") +
      ". No child was launched. Fix the args and relaunch — a numeric arg must be a " +
      "number (a quoted number is a different number to the harness)."
  };
}

// A launch that the harness rejects is a CONFIG failure, not a child
// failure: the child never started, so no ticket can be blamed for it.
function isConfigError(err) {
  return /must be an integer|must be a valid|is not supported|is invalid|requires a params|accepts one child|gate cannot be combined|unsupported/i.test(String(err || ""));
}

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

emit("implement-spec: spec=" + specRef + " tickets=" + ticketsRef +
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
function readTicketGraph(fresh) {
  const task = [
    "Enumerate this run's tickets from the configured issue tracker.",
    "The tracker target for this run: " + ticketsRef,
    "Read docs/agents/issue-tracker.md and follow its tracker workflow. Do NOT assume tickets are files.",
    "Read ONLY that target. If it does not exist, or matches no tickets, return",
    'an empty tickets array. Never substitute a similar-looking target, another',
    "feature's tickets, or issues you found by searching: an empty answer is the",
    "correct answer for an empty target, while a plausible answer about someone",
    "else's tickets would be read as a verified run over this one.",
    "For EACH ticket output one object with:",
    "  ref: the ticket's reference in this tracker (e.g. 07, #42, PROJ-123),",
    "  title: the ticket title,",
    "  type: the tracker's issue type/kind when available,",
    "  resolved: true when the tracker marks the ticket closed/done, else false,",
    "  blockedBy: the refs of every ticket this one is blocked by ([] if none),",
    "  onBranch: true when the integration branch " + baseRef + " carries",
    "  this ticket's work. New commits include an exact `Issue: <ref>` body",
    "  trailer; legacy commits may start with `Implement ticket <ref>:`. Search",
    "  both forms. A status-only commit does not count. Report false when the",
    "  work itself is absent from the branch.",
    "  groomed: true when the issue meets the ready-for-implementation criteria",
    "  in docs/agents/issue-tracker.md, false otherwise. Do not modify the issue.",
    "Keep each object on ONE line. Compact JSON, no whitespace. Include type when available.",
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
    '{"tickets":[{"ref":"07","title":"...","resolved":false,"blockedBy":[],"onBranch":false,"groomed":true}],',
    ' "preflight":{"trackerConfigured":true,"integrationBranchExists":true,"integrationBranch":"' + integrationBranch + '"}}'
  ].join("\n");
  return runs.run(fresh ? "ticket-graph-forced" : "ticket-graph", {
    label: "Read ticket graph from " + ticketsRef,
    agent: AG.scout,
    task: task,
    timeoutMs: 10 * 60 * 1000,
    quiet: true
    // Deliberately NO outputSchema here. A step with an outputSchema must
    // finish by calling the harness's structured_output tool; a model that
    // answers with the JSON document as text — which is exactly what this
    // task asks for — is then REJECTED, and the whole run dies with "no
    // tickets found" while the correct JSON sits in the child's output. The
    // script parses the child's text itself (statusesFromGraph), with a
    // per-object recovery path for a truncated tail, so the schema bought
    // nothing and cost the run its discovery.
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
    "Issue (read it first using docs/agents/issue-tracker.md): " + ticket.ref,
    "Full spec for background context only: " + specRef,
    ""
  ];
  if (TRACKER_HINT) {
    task.push("Tracker (this repo's convention — your worktree may not carry the tracker doc):", TRACKER_HINT, "");
  }
  task.push(
    "Rules:",
    "- Implement only this ticket. Other tickets belong to other workers.",
    "- The orchestrator dispatches only tickets confirmed ready by the grooming preflight. If this ticket is not ready, stop and report GROOM_NEEDED; do not implement or change lifecycle status.",
    "- Record acceptance evidence and an implementation summary according to docs/agents/issue-tracker.md.",
    "- Do not change lifecycle status; the orchestrator owns In Progress and Ready for Review transitions, and Complete is post-merge only.",
    "- Write/update tests for every criterion (unit/integration/E2E per spec).",
    "- Your tree already branches from " + integrationBranch + "; do NOT create",
    "  branches, worktrees, or spawn subagents.",
    "- Do NOT run git commit — leave your changes uncommitted in the worktree;",
    "  the orchestrator captures and merges them.",
    "",
    "Return a concise summary: what you implemented, test results, decisions."
  );
  return runs.run(key, {
    label: "Implement ticket " + ticket.ref + ": " + ticket.title,
    agent: AG.implementer,
    task: task.join("\n"),
    worktree: true,
    baseRef: baseRef,
    timeoutMs: IMPL_TIMEOUT_MS,
    gate: gateFor(ticket.ref),
    control: childControl(),
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
    gate: gateFor(ticket.ref),
    control: childControl()
  });
}

// The harness captures an implementer's uncommitted work as a patch inside
// the child's own run directory, and keeps the worktree on disk. The
// workflow sandbox has no filesystem access, so the concrete location has to
// be derived here and handed to the merger/fixer — otherwise they are told
// to "inspect handoffs/" and have to guess where that is.
function patchLocation(result) {
  if (!result) return { runId: "unknown", asyncDir: null };
  const runId = result.runId || "unknown";
  const paths = Array.isArray(result.artifactPaths) ? result.artifactPaths : [];
  const asyncDir = paths.find(function(p) {
    return typeof p === "string" && p.indexOf("async-subagent-runs") >= 0;
  }) || null;
  return { runId: runId, asyncDir: asyncDir };
}
function patchHint(result) {
  const loc = patchLocation(result);
  if (!loc.asyncDir) {
    // Timeout/failure case: runId and artifactPaths may be missing from the
    // result (e.g. a timeout that threw before the harness captured them).
    // Point children to a directory search instead of a dead "unknown/" path,
    // and note the resume/continue-child fallback.
    return {
      runId: loc.runId,
      dir: null,
      text: "run-directory/worktree-diffs/step-0/  (the captured patch is the *.patch file)" +
        "\n  If runId is 'unknown' (the child failed before the harness captured it):" +
        "\n    ls -dt ${TMPDIR:-/tmp}/pi-subagents-*/async-subagent-runs/*/worktree-diffs/step-0/*.patch | head -5" +
        "\n    identify the patch by its contents (it should touch the ticket's files)." +
        "\n  Note: the resume and continue-child tiers use `git worktree list --porcelain`" +
        "\n  to find the retained worktree; if runId is also unknown, search for worktrees" +
        "\n  with uncommitted changes matching the ticket's files."
    };
  }
  return {
    runId: loc.runId,
    dir: loc.asyncDir + "/worktree-diffs/step-0/",
    text: loc.asyncDir + "/worktree-diffs/step-0/  (the captured patch is the *.patch file in that directory)"
  };
}

// Gate-failure remediation: a fixer child in a FRESH managed worktree that
// applies the previous run's captured patch and repairs it. The worktree is
// new but the WORK is not from scratch — it starts from the previous patch.
function spawnFixer(ticket, priorResult, wave) {
  const key = "fix-" + wave + "-t" + keyOf(ticket.ref);
  const hint = patchHint(priorResult);
  const runId = hint.runId;
  const task = [
    "REMEDIATION: the implementer for ticket " + ticket.ref + " completed but",
    "FAILED its verification gate. Its work is preserved as a captured patch;",
    "your job is to repair it, not rewrite it from scratch.",
    "",
    "Ticket: " + ticket.ref,
    "Previous run id: " + (runId || "unknown"),
    "Where the captured patch is: " + hint.text,
    "  ls -d \"${TMPDIR:-/tmp}\"/pi-subagents-*/async-subagent-runs/" + (runId || "<runId>") + "/",
    "",
    "Steps:",
    "1. Locate the previous run's captured patch (the *.patch file in the",
    "   directory named above).",
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
    gate: gateFor(ticket.ref),
    control: childControl()
  });
}

// Merger child: applies the implementer's captured patch (located via the
// handoff manifest, or directly from a reported worktree path for
// continue-children) onto the integration branch in the main checkout, then
// re-verifies the gate there. The commit check is idempotent so a retried
// merger after a partial merge succeeds cleanly.
function spawnMerger(ticket, implResult, wave, worktreePath) {
  const hint = patchHint(implResult);
  const key = "merge-" + wave + "-t" + keyOf(ticket.ref);
  const gate = gateFor(ticket.ref);
  const source = worktreePath
    ? [
        "The implementer worked directly in a retained worktree at:",
        "  " + worktreePath,
        "Capture its uncommitted changes from there, e.g.:",
        "  git -C " + worktreePath + " diff > /tmp/ticket-" + keyOf(ticket.ref) + ".patch",
        "then apply in the main checkout: git apply --whitespace=fix --index /tmp/ticket-" + keyOf(ticket.ref) + ".patch"
      ]
    : [
        "The implementer ran in a managed worktree; its uncommitted work was",
        "captured as a patch in that run's own directory. Find it with:",
        "  ls " + (hint.dir || "<run dir>/worktree-diffs/step-0/"),
        "  (the *.patch file in there is the captured work)",
        "Its run id is " + hint.runId + ". Its worktree is still on disk:",
        "  git worktree list --porcelain | grep " + hint.runId,
        "Candidate manifest/artifact paths: " + hint.text
      ];
  const mergerTask = [
    "Merge one completed implementer's work into " + integrationBranch + ".",
    ""
  ];
  mergerTask.push.apply(mergerTask, checkoutHint());
  mergerTask.push(
    "",
    "Ticket: " + ticket.ref,
    "",
    "Implementer changes source:",
    source.join("\n"),
    "",
    "Steps:",
    "1. Confirm the main checkout is on " + integrationBranch + " and clean",
    "   (git status). If it is dirty or on another branch, STOP and report.",
    "2. If a commit with an exact `Issue: " + ticket.ref + "` body trailer or the",
    "   legacy subject `Implement ticket " + ticket.ref + ":` already exists, report",
    "   that the merge was already done and exit successfully; do not merge twice.",
    "3. Apply the implementer's changes (per the source above). If the patch is",
    "   empty or already applied, note that and continue.",
    "4. Read the issue and diff, then create a Conventional Commit subject using the appropriate type and a concise change summary. Include `Issue: " + ticket.ref + "` as a commit-body trailer. Do not use a generic 'Implement ticket' subject.",
    "5. Commit using that subject and trailer, then validate both:",
    "   git log -1 --format=%s | grep -Eq '^[a-z][a-z0-9-]*(\\([a-z0-9._/-]+\\))?!?: .+'",
    "   git show -s --format=%B HEAD | grep -Fx 'Issue: " + ticket.ref + "'",
    "   If either check fails, amend only the message and re-check.",
    "6. Re-run the verification gate yourself as well: " + gate.command,
    "7. Do NOT delete branches or run any worktree-manager commands.",
    "",
    "If the patch cannot be found or applied, report FAILURE clearly and",
    "change nothing.",
    "",
    "Return: merge status, commit hash, gate result."
  );
  return runs.run(key, {
    label: "Merge ticket " + ticket.ref + " into " + integrationBranch,
    agent: AG.merger,
    task: mergerTask.join("\n"),
    timeoutMs: MERGE_TIMEOUT_MS,
    gate: gate,
    control: childControl()
  });
}

// Independent verification of one merged ticket's acceptance criteria.
//
// The implementer checks off its own boxes; the merger proves the gate is
// green on the integration branch. Neither answers "does the code actually do
// what the ticket asked for?". This child answers that from first-hand
// evidence, and a ticket only counts as merged when it does. It runs in the
// main checkout, because the work it verifies is the merged work.
function spawnVerifier(ticket, wave) {
  const key = "verify-" + wave + "-t" + keyOf(ticket.ref);
  const task = [
    "Independently verify ONE already-merged ticket's acceptance criteria",
    "against the code in the checkout below.",
    ""
  ];
  task.push.apply(task, checkoutHint());
  task.push(
    "",
    "The one ticket you own: " + ticket.ref + ".",
    "Read it and record against it using the tracker convention in",
    "docs/agents/issue-tracker.md.",
    "What to verify against: branch " + integrationBranch + " in that checkout,",
    "the spec reference " + specRef + ", and the ticket above.",
    "Targeted test command form: " + (RETEST_COMMAND
      ? RETEST_COMMAND + " — substitute the test that covers the criterion."
      : "read docs/agents/verification.md for how this repo runs one narrow slice of tests."),
    ""
  );
  if (TRACKER_HINT) {
    task.push("Tracker (this repo's convention — your worktree may not carry the tracker doc):", TRACKER_HINT, "");
  }
  task.push(
    "The implementer for this ticket checked off its own acceptance criteria.",
    "Do not take that as evidence — re-derive each criterion from the code:",
    "1. Read the ticket via the tracker doc and list every acceptance criterion.",
    "2. For EACH criterion, gather first-hand evidence: inspect the code that",
    "   implements it and, where meaningful, run the targeted test for it.",
    "   Reading the code and its tests together counts as evidence; an",
    "   unexecuted assertion does not prove runtime behavior.",
    "3. Report each criterion as satisfied or not satisfied, with evidence",
    "   (file:line, test name, command, result).",
    "",
    "The ticket may already be merged on that branch, but check rather than",
    "assume: if the work is NOT there, that is a finding — report the criterion",
    "as not satisfied. Do not conclude anything about work you cannot see.",
    "",
    "Record verification evidence using docs/agents/issue-tracker.md, including",
    "file paths, test names, commands run, and any gap. Do not change lifecycle",
    "status or alter acceptance outcomes. You report evidence; lifecycle changes",
    "are handled by the orchestrator at the documented phase boundaries.",
    "",
    "Rules:",
    "- Touch only this ticket. Do NOT edit code, do NOT commit, do NOT change",
    "  git state, do NOT spawn subagents.",
    "",
    "The LAST line of your final response MUST be exactly one of:",
    "  Verification verdict: OK    — every criterion is satisfied, with evidence",
    "  Verification verdict: UNMET  — at least one criterion is not satisfied",
    "A missing verdict is treated as NOT verified."
  );
  return runs.run(key, {
    label: "Verify ticket " + ticket.ref + " against the merged code",
    agent: AG.verifier,
    task: task.join("\n"),
    timeoutMs: MERGE_TIMEOUT_MS,
    control: childControl()
  });
}

// A missing verdict is not a pass — the same rule the review axes follow.
function parseVerification(output) {
  const text = String(output || "");
  if (text.indexOf("Verification verdict: OK") >= 0) return "OK";
  if (text.indexOf("Verification verdict: UNMET") >= 0) return "UNMET";
  return "UNVERDICTED";
}

// Review axis task template — extracted so the retry logic can re-launch
// individual failed axes with a fresh key (bypassing runs.run cache reuse).
function reviewAxisTask(axis, focus) {
  const task = [
    "You are the " + axis + " reviewer for the implement-spec workflow.",
    "Review the work integrated on branch " + integrationBranch + " (git log/diff",
    "against " + BASE_BRANCH + " as needed). Focus: " + focus,
    "Spec: " + specRef + "  Tickets: " + ticketsRef,
    ""
  ];
  task.push.apply(task, checkoutHint());
  task.push(
    "",
    "Review ONLY that target. First confirm it exists: if the branch named",
    "above does not resolve, or the spec or ticket reference does not",
    "resolve (a path that is not there, a ticket the tracker does not have),",
    "do NOT pick a nearby branch, another feature's tickets, or the current",
    "checkout and review that instead — a confident report about the wrong",
    "work is worse than no report. In that case answer with one line:",
    "'Review verdict: MISSING_TARGET' plus what was absent, and stop.",
    "",
    "Report concrete findings with file:line references. Otherwise end with",
    "exactly one line: 'Review verdict: BLOCK' if there are must-fix defects,",
    "or 'Review verdict: OK' if there are none. No other final line is a",
    "verdict; the orchestrator treats a missing one as an unfinished review."
  );
  return task.join("\n");
}
// Three-axis review over the integrated branch, run in parallel.
function spawnReviews(wave) {
  return runs.all(REVIEW_AXES.map(function(a) {
    return runs.run("review-" + a.name + "-" + wave, {
      label: "Review " + a.name + " axis",
      agent: a.agent,
      task: reviewAxisTask(a.name, a.focus),
      timeoutMs: MERGE_TIMEOUT_MS,
      control: childControl()
    });
  }));
}
// Retry a single UNVERDICTED review axis with a fresh key (avoids cache reuse).
function respawnReview(axis, attempt) {
  const cfg = REVIEW_AXES.filter(function(a) { return a.name === axis; })[0];
  return runs.run("review-" + axis + "-retry-" + attempt, {
    label: "Review " + axis + " axis (retry " + attempt + ")",
    agent: cfg.agent,
    task: reviewAxisTask(axis, cfg.focus),
    timeoutMs: MERGE_TIMEOUT_MS,
    control: childControl()
  });
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
  // A launch the harness rejected is a CONFIG failure: the child never
  // started, so no ticket is at fault and no remediation cycle applies.
  if (isConfigError(err)) return "config";
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
  // Only the JSON document counts. A scout that adds a note after the JSON
  // ("no UNREADABLE entries are appended") must not be read as reporting one.
  const text = String((result && result.output) || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const json = (start >= 0 && end > start) ? text.slice(start, end + 1) : text;
  const unreadable = json.match(/UNREADABLE:\s*\S+/g) || [];
  unreadable.forEach(function(u) {
    emit("ticket-graph: " + u + ": ticket unreadable this wave");
  });
}
function getTicketGraph(forceDiscovery) {
  if (ticketGraphCache && !forceDiscovery) {
    emit("ticket graph: reused cached discovery (ticketsRef unchanged since last read)");
    return Promise.resolve(ticketGraphCache);
  }
  return readTicketGraph(forceDiscovery).then(function(result) {
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
      + (graphOk
          ? ""
          : " (the discovery run itself failed"
            + (graphRun && graphRun.error ? ": " + String(graphRun.error).slice(0, 300) : "")
            + ")")
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
if (preflight && preflight.integrationBranchExists === false && !finalizeMergedPR) {
  // The branch doesn't exist yet. Create it from BASE_BRANCH before any
  // worktree child launches — they all branch from baseRef and would fail
  // without it. The script can't invoke git directly, so we spawn a lightweight
  // child in the main checkout.
  emit("implement-spec: integration branch '" + integrationBranch + "' does not resolve; creating from " + BASE_BRANCH);
  const ensureRun = await runs.run("ensure-integration-branch", {
    agent: AG.worker,
    label: "Create integration branch " + integrationBranch + " from " + BASE_BRANCH,
    task: "Ensure the git branch '" + integrationBranch + "' exists in " + REPO_PATH +
      ", creating it from '" + BASE_BRANCH + "' if it does not.\n" +
      "1. git -C " + REPO_PATH + " rev-parse --verify refs/heads/" + integrationBranch +
      " -> if it succeeds, report BRANCH_EXISTS and exit.\n" +
      "2. If it fails: git -C " + REPO_PATH + " branch " + integrationBranch + " " + BASE_BRANCH +
      " && git -C " + REPO_PATH + " push -u origin " + integrationBranch + ". Report BRANCH_CREATED.\n" +
      "3. Change nothing else. Do not switch branches or modify files.",
    timeoutMs: 30 * 1000,
    quiet: true
  });
  if (!ensureRun || !ensureRun.ok || !ensureRun.output ||
      ensureRun.output.indexOf("BRANCH_CREATED") < 0 && ensureRun.output.indexOf("BRANCH_EXISTS") < 0) {
    return {
      ok: false,
      error: "implement-spec: could not create integration branch '" + integrationBranch + "' from " +
        BASE_BRANCH + ". " + (ensureRun && ensureRun.error ? String(ensureRun.error).slice(0, 200) : ""),
      preflight: preflight,
      discoveredTickets: tickets.length
    };
  }
  emit("implement-spec: integration branch '" + integrationBranch + "' ensured (" +
       String((ensureRun.output || "").match(/BRANCH_EXISTS|BRANCH_CREATED/) || ["UNKNOWN"])[0] + ")");
}
if (!preflight) {
  emit("implement-spec: discovery reported no preflight; cannot confirm " + baseRef +
       " resolves before wave 1. Implementers will fail on baseRef if it does not exist.");
}

if (finalizeMergedPR) {
  const refs = tickets.map(function(ticket) { return String(ticket.ref); }).filter(Boolean);
  if (!preflight || preflight.trackerConfigured !== true || !refs.length) {
    return {
      ok: false,
      finalized: false,
      error: "Cannot finalize: the issue tracker could not read every in-scope issue. No Complete transitions were attempted.",
      issues: refs
    };
  }
  const confirmation = await confirmMerged(refs, String(A.prUrl || A.mergeRef));
  if (!confirmation || !confirmation.ok || !/MERGED_CONFIRMED/.test(String(confirmation.output || ""))) {
    return {
      ok: false,
      finalized: false,
      error: "The issue tracker did not confirm that the merge is complete. No Complete transitions were attempted.",
      mergeEvidence: String((confirmation && confirmation.output) || ""),
      issues: refs
    };
  }
  const transitionFailures = [];
  const transitionUnsupported = [];
  for (const ref of refs) {
    const transition = await runTransition("complete", ref, {
      branch: integrationBranch,
      prUrl: A.prUrl || A.mergeRef
    });
    if (!transition || !transition.ok) transitionFailures.push(ref);
    else if (transition.unsupported) transitionUnsupported.push(ref);
  }
  return {
    ok: transitionFailures.length === 0,
    finalized: transitionFailures.length === 0,
    issues: refs,
    transitionFailures: transitionFailures,
    transitionUnsupported: transitionUnsupported,
    error: transitionFailures.length ? "Merge was confirmed, but some issues could not be transitioned to Complete." : null
  };
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
    blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
    groomed: !!t.groomed
  };
}
emit("implement-spec: discovered " + order.length + " tickets: " + order.join(", "));
// Pre-flight: tickets not ready under the tracker doc stay out of the frontier.
for (const ref of order) {
  if (byRef[ref] && byRef[ref].groomed === false) {
    emit("implement-spec: ticket " + ref + " is GROOM_NEEDED; it will not be dispatched until it meets docs/agents/issue-tracker.md readiness criteria.");
  }
}

const merged = [];        // ticket refs implemented AND merged
const escalated = [];     // tickets given up to the lead after maxRemediations
const verifications = []; // per-ticket independent verification verdicts
const absorbedPending = []; // issues whose ticket commits are already on branch, awaiting verification
const waveReports = [];
let totalRemediations = 0;
let waveCount = 0;        // survives the wave loop for the closing sequence

if (verifyOnly) {
  // Resume mode: no implementation. Treat ticket commits already on the
  // integration branch as pending independent verification, regardless of
  // whether the tracker has been closed yet.
  const st0 = statusesFromGraph(graphRun);
  for (const s of st0) {
    const ref = (s.ref === undefined || s.ref === null) ? "" : String(s.ref);
    if (!ref) continue;
    if (s.onBranch) {
      ledgerFor(ref).state = "merged";
      absorbedPending.push(ref);
    } else if (s.resolved) {
      emit("ticket " + ref + ": the tracker marks it resolved but the integration branch does not carry the work; it is not done");
      ledgerFor(ref).state = "unresolved";
    } else {
      ledgerFor(ref).state = "unresolved";
    }
  }
  emit("verifyOnly: " + absorbedPending.length + " issues already on the integration branch; skipping implementation waves");
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
    const onBranchByRef = {};
    for (const s of statuses) {
      const ref = (s.ref === undefined || s.ref === null) ? "" : String(s.ref);
      if (ref) {
        resolvedByRef[ref] = !!s.resolved;
        onBranchByRef[ref] = !!s.onBranch;
        if (byRef[ref]) byRef[ref].groomed = !!s.groomed;
      }
    }

    // Frontier: unresolved, not merged, not escalated, all blockers merged.
    const frontier = [];
    for (const ref of order) {
      const t = byRef[ref];
      const ld = ledgerFor(ref);
      if (ld.state === "merged" || ld.state === "escalated") continue;
      if (onBranchByRef[ref]) {
        // The ticket commit is already present, even if the tracker remains
        // In Progress or Ready for Review. Verify it rather than reimplementing.
        ld.state = "merged";
        absorbedPending.push(ref);
        continue;
      }
      if (!t.groomed) {
        emit("ticket " + ref + ": GROOM_NEEDED; not dispatched until it is groomed per docs/agents/issue-tracker.md");
        continue;
      }
      if (resolvedByRef[ref]) {
        emit("ticket " + ref + ": the tracker marks it resolved but the integration branch does not carry its commit; it will be implemented again");
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
    // Transition frontier issues before implementation. A failed tracker update
    // blocks the batch so code cannot advance while the tracker says otherwise.
    const transitionFailures = [];
    for (const t of batch) {
      const transition = await runTransition("in_progress", t.ref, { branch: integrationBranch });
      if (!transition || !transition.ok) transitionFailures.push(t.ref);
    }
    if (transitionFailures.length) {
      return {
        ok: false,
        integrationBranch: integrationBranch,
        error: "Could not transition these issues to In Progress; no implementers were launched: " + transitionFailures.join(", "),
        transitionFailures: transitionFailures,
        merged: merged,
        escalated: escalated
      };
    }

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
      if (isConfigError(e)) {
        // The harness rejected the launch itself. No child started, so no
        // ticket is at fault: stop the run instead of spending the whole
        // remediation budget on a configuration mistake.
        return {
          ok: false,
          error: "implement-spec config error while launching wave " + wave + ": " + String(e) +
            ". No child was launched and no ticket is at fault. Fix the launch configuration and relaunch.",
          integrationBranch: integrationBranch,
          waves: waveReports.length,
          merged: merged,
          escalated: escalated,
          unresolved: order.filter(function(num) { return merged.indexOf(num) < 0; }),
          configError: true
        };
      }
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
            if (isConfigError(e2)) {
              return {
                ok: false,
                error: "implement-spec config error while launching ticket " + t.ref + ": " + String(e2) +
                  ". No child was launched and no ticket is at fault. Fix the launch configuration and relaunch.",
                integrationBranch: integrationBranch,
                waves: waveReports.length,
                merged: merged,
                escalated: escalated,
                unresolved: order.filter(function(num) { return merged.indexOf(num) < 0; }),
                configError: true
              };
            }
            emit("wave " + wave + ": serial spawn for ticket " + t.ref + " rejected (" + e2 + ")");
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

      if (cls === "config") {
        // The harness rejected the launch: the child never started, so the
        // ticket is not at fault. Abort the run — a configuration mistake
        // must not become a remediation cycle and a bogus escalation.
        emit("implement-spec: CONFIG error launching ticket " + ticket.ref + " — aborting run");
        return {
          ok: false,
          error: "implement-spec config error while launching ticket " + ticket.ref + ": " +
            ((implResult && implResult.error) || "unknown") +
            ". No child was launched and no ticket is at fault. Fix the launch configuration and relaunch.",
          integrationBranch: integrationBranch,
          waves: waveReports.length,
          merged: merged,
          escalated: escalated,
          unresolved: order.filter(function(num) { return merged.indexOf(num) < 0; }),
          configError: true
        };
      }

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
        // The work is on the integration branch and the gate is green there.
        // That proves the branch is not broken — not that the ticket's
        // acceptance criteria are met. Verify them independently before the
        // ticket counts as merged.
        let verifyRun = null;
        try {
          verifyRun = await spawnVerifier(ticket, wave);
        } catch (eVer) {
          emit("ticket " + ticket.ref + ": verifier launch rejected (" + eVer + ")");
        }
        const verdict = (verifyRun && verifyRun.ok) ? parseVerification(verifyRun.output) : "UNVERDICTED";
        ld.verification = verdict;
        verifications.push({
          ref: ticket.ref,
          verdict: verdict,
          excerpt: String((verifyRun && verifyRun.output) || "").slice(0, 400)
        });
        if (verdict !== "OK") {
          escalate(ticket.ref, "independent verification did not pass (" + verdict + ")",
                   "the work is merged into " + integrationBranch + " but its acceptance criteria are unverified. " +
                   "Lead decision needed: targeted fix, or accept the gap explicitly.");
          ld.state = "escalated";
          escalated.push(ticket.ref);
          continue;
        }
        ld.state = "merged";
        merged.push(ticket.ref);
        progressThisWave = progressThisWave + 1;
        emit("ticket " + ticket.ref + ": merged into " + integrationBranch + " and independently verified");
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
// Absorption check: an issue commit already on the integration branch is
// independently verified even if lifecycle status remains In Progress or
// Ready for Review. Tracker closure without a matching branch commit is not
// treated as implementation.
// ---------------------------------------------------------------------------
if (absorbedPending.length) {
  for (const ref of absorbedPending) {
    const ticket = byRef[ref];
    if (!ticket) continue;
    let verifyRun = null;
    try {
      verifyRun = await spawnVerifier(ticket, 0);
    } catch (eVer) {
      emit("ticket " + ref + ": verifier launch rejected (" + eVer + ")");
    }
    const verdict = (verifyRun && verifyRun.ok) ? parseVerification(verifyRun.output) : "UNVERDICTED";
    ledgerFor(ref).verification = verdict;
    verifications.push({
      ref: ref,
      verdict: verdict,
      excerpt: String((verifyRun && verifyRun.output) || "").slice(0, 400)
    });
    if (verdict === "OK") {
      merged.push(ref);
      emit("ticket " + ref + ": work on " + integrationBranch + " is independently verified");
    } else {
      escalate(ref, "work already on " + integrationBranch + " did not verify (" + verdict + ")",
               "the issue commit was present on the branch, but its acceptance criteria did not verify. " +
               "Lead decision needed: targeted fix, or accept the gap explicitly.");
      ledgerFor(ref).state = "escalated";
      escalated.push(ref);
    }
  }
}

// ---------------------------------------------------------------------------
// Closing sequence — final verify, three-axis review, fix pass, PR.
// ---------------------------------------------------------------------------
const unresolved = order.filter(function(ref) {
  return merged.indexOf(ref) < 0 && escalated.indexOf(ref) < 0;
});
let reviews = null;
let reviewsIncomplete = false;
let fixRun = null;
let fixMergerRun = null;
let prRun = null;
let prEligible = false;
let finalVerifyPassed = false;
let prWaived = false;
let reviewsAccepted = false;
let runComplete = false;
let readyTransitionFailures = [];
let prCreated = false;
let prUrl = null;
let prSurfaceUnavailable = false;
let prFailed = false;

if (merged.length) {
  // Final verification: full suite (including e2e) on the integrated branch.
  let verifyRun = null;
  const finalVerifyTask = [
    "Final verification pass on branch " + integrationBranch + " in the checkout below.",
    ""
  ];
  finalVerifyTask.push.apply(finalVerifyTask, checkoutHint());
  finalVerifyTask.push(
    "",
    "First confirm that branch resolves. If it does not, change nothing, run",
    "nothing, and reply 'MISSING_TARGET' with what you checked — do NOT",
    "substitute another branch or treat the current checkout as the target.",
    "Run the FULL test suite with: " + FULL_GATE,
    "If anything fails, investigate and fix directly (no subagents), then",
    "re-run until green. If you commit a fix, use a Conventional Commit subject and add `Issue: <ref>` trailers for affected issues from this run: " + merged.join(", ") + ".",
    "Validate the subject with `git log -1 --format=%s | grep -Eq '^[a-z][a-z0-9-]*(\\([a-z0-9._/-]+\\))?!?: .+'` and verify each issue trailer in the commit body. Return the test runner's summary line."
  );
  try {
    verifyRun = await runs.run("final-verify", {
      label: "Final full-suite verification",
      agent: AG.merger,
      task: finalVerifyTask.join("\n"),
      timeoutMs: MERGE_TIMEOUT_MS,
      gate: gateObj(FULL_GATE),
      control: childControl()
    });
  } catch (eV) {
    emit("implement-spec: final-verify rejected (" + eV + ")");
  }
  finalVerifyPassed = !!(verifyRun && verifyRun.ok);
  if (!finalVerifyPassed) {
    emit("implement-spec: final full-suite verification FAILED; PR eligibility is blocked");
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
      excerpt: out.slice(0, 4000)
    };
  });
  let blockedAxes = reviews.filter(function(r) { return r.verdict === "BLOCK"; });
  // Incomplete review = fewer than three axes came back, or any axis returned
  // without a verdict, or refused because its target was missing. That is not a
  // green light; it is an unknown.
  let unreviewedAxes = reviews.filter(function(r) { return r.verdict !== "BLOCK" && r.verdict !== "OK"; });
  reviewsIncomplete = reviews.length < 3 || unreviewedAxes.length > 0;

  // Retry UNVERDICTED review axes (transient failures like model-provider
  // Cloudflare blocks). Process results individually — a partial runs.all
  // result preserves surviving verdicts instead of discarding all of them.
  let reviewRetryAttempt = 0;
  while (reviewsIncomplete && reviewRetryAttempt < MAX_REVIEW_RETRIES) {
    reviewRetryAttempt = reviewRetryAttempt + 1;
    const retryAxes = reviews.filter(function(r) { return r.verdict === "UNVERDICTED"; });
    if (!retryAxes.length) break;
    emit("implement-spec: retrying UNVERDICTED review axes: " +
         retryAxes.map(function(r) { return r.axis; }).join(", ") +
         " (attempt " + reviewRetryAttempt + "/" + MAX_REVIEW_RETRIES + ")");
    const retryResults = await Promise.all(retryAxes.map(function(r) {
      return respawnReview(r.axis, reviewRetryAttempt)
        .then(function(res) { return res; })
        .catch(function(e) {
          return { ok: false, error: String(e), output: "", runId: null };
        });
    }));
    retryAxes.forEach(function(r, i) {
      const res = retryResults[i];
      const out = (res && res.output) ? String(res.output) : "";
      let verdict = "UNVERDICTED";
      if (res && res.ok) {
        if (out.indexOf("Review verdict: BLOCK") >= 0) verdict = "BLOCK";
        else if (out.indexOf("Review verdict: OK") >= 0) verdict = "OK";
        else if (out.indexOf("Review verdict: MISSING_TARGET") >= 0) verdict = "MISSING_TARGET";
      }
      const idx = reviews.findIndex(function(x) { return x.axis === r.axis; });
      reviews[idx] = { axis: r.axis, ok: !!(res && res.ok), verdict: verdict, excerpt: out.slice(0, 4000) };
    });
    blockedAxes = reviews.filter(function(r) { return r.verdict === "BLOCK"; });
    unreviewedAxes = reviews.filter(function(r) {
      return r.verdict !== "BLOCK" && r.verdict !== "OK";
    });
    reviewsIncomplete = reviews.length < 3 || unreviewedAxes.length > 0;
  }

  if (reviewsIncomplete) {
    const detail = unreviewedAxes.map(function(r) { return r.axis + ":" + r.verdict; });
    emit("ESCALATION: review is INCOMPLETE" +
         (detail.length ? " — axes without a verdict: " + detail.join(", ")
                        : " — only " + reviews.length + " of 3 axes returned") +
         ". An axis with no 'Review verdict:' line is not a pass. PR suppressed; Lead decision needed: re-run the review or accept the gap explicitly.");
  }

  if (blockedAxes.length && !(PR_WAIVER_REASON && !skipPR)) {
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
        gate: gateObj(FULL_GATE),
        control: childControl()
      });
    } catch (eFx) {
      emit("implement-spec: fix-review-findings rejected (" + eFx + ")");
    }

    if (fixRun && fixRun.ok) {
      const fixHint = patchHint(fixRun);
      const fixMergeTask = [
        "Merge the review-fix implementer's captured patch into " + integrationBranch + ".",
        ""
      ];
      fixMergeTask.push.apply(fixMergeTask, checkoutHint());
      fixMergeTask.push(
        "",
        "The fixer ran in a managed worktree; its patch was captured in that",
        "run's own directory. Where it is: " + fixHint.text,
        "  ls " + (fixHint.dir || "<run dir>/worktree-diffs/step-0/"),
        "",
        "Steps:",
        "1. Confirm the main checkout is on " + integrationBranch + " and clean.",
        "2. Locate and apply the captured patch (git apply --whitespace=fix --index <patch>).",
        "3. Commit with a Conventional Commit subject whose type matches the fixes, such as `fix: address review findings`, and include `Issue: <ref>` trailers for each affected issue in this run: " + merged.join(", ") + ".",
        "4. Validate the subject with `git log -1 --format=%s | grep -Eq '^[a-z][a-z0-9-]*(\\([a-z0-9._/-]+\\))?!?: .+'` and validate the Issue trailers for the affected issues in this run: " + merged.join(", ") + ".",
        "   If either check fails, amend only the message and re-check.",
        "5. Re-run the full gate yourself: " + FULL_GATE,
        "6. Return: merge status, commit hash, gate result."
      );
      try {
        fixMergerRun = await runs.run("merge-review-fixes", {
          label: "Commit and merge review fixes into " + integrationBranch,
          agent: AG.merger,
          task: fixMergeTask.join("\n"),
          timeoutMs: MERGE_TIMEOUT_MS,
          gate: gateObj(FULL_GATE),
          control: childControl()
        });
      } catch (eM) {
        emit("implement-spec: merge-review-fixes rejected (" + eM + ")");
      }
      if (fixMergerRun && fixMergerRun.ok) finalVerifyPassed = true;
      if (!fixMergerRun || !fixMergerRun.ok) {
        // Acceptance-format rejection does not mean the work is absent.
        // The fixer's changes may already be on the branch. Verify git state
        // directly: if the expected changes are present and the gate passes,
        // treat the merge as successful rather than escalating.
        const gmVerify = await runs.run("verify-fix-merge-" + keyOf(ticket.ref), {
          agent: AG.merger,
          label: "Verify fix-merge git state for " + ticket.ref,
          task: "The merge-review-fixes child reported failure, but its work may already be committed. " +
            "Confirm: (1) checkout is on " + integrationBranch + " and clean; " +
            "(2) the fixer's changes are present (git log --oneline main.." + integrationBranch +
            " shows commits beyond the original implementation); (3) the gate " + FULL_GATE +
            " passes. If (3) passes and (2) shows changes, report MERGE_EFFECTIVE. " +
            "If the changes are NOT present, report MERGE_MISSING. " + checkoutHint(),
          timeoutMs: MERGE_TIMEOUT_MS,
          gate: gateObj(FULL_GATE),
          control: childControl()
        }).catch(function(e) {
          emit("implement-spec: fix-merge verification rejected (" + e + ")");
          return null;
        });
        const gmOutput = (gmVerify && gmVerify.output) ? String(gmVerify.output) : "";
        if (gmVerify && gmVerify.ok && gmOutput.indexOf("MERGE_EFFECTIVE") >= 0) {
          emit("implement-spec: fix-merge acceptance rejected but git state verified; treating as merged");
          fixMergerRun = { ok: true, output: gmOutput };
          finalVerifyPassed = true;
        } else {
          emit("ESCALATION: review fixes were produced but NOT merged into " +
               integrationBranch + " — the fixer's worktree may hold uncommitted work, and " +
               "the git-state verification did not confirm it is on the branch. " +
               "Lead decision needed before any PR.");
        }
      }
    } else {
      emit("ESCALATION: review fix pass failed or was rejected — lead decision needed before any PR.");
    }
  }

  // PR only when the tree is in a known-good state: the review actually
  // completed, and there are either no blockers or blockers fixed AND merged.
  // Never open a PR from a pre-fix commit, or from an unknown review state.
  const fixesClean = (!blockedAxes.length || (fixRun && fixRun.ok && fixMergerRun && fixMergerRun.ok)) && !reviewsIncomplete;
  // A user may explicitly waive completed review blockers, but never a red
  // final gate, incomplete review, or unfinished issue graph.
  runComplete = escalated.length === 0 && unresolved.length === 0;
  prWaived = !!(!skipPR && PR_WAIVER_REASON && blockedAxes.length && !reviewsIncomplete && finalVerifyPassed && runComplete && !fixesClean);
  reviewsAccepted = fixesClean || prWaived;
  prEligible = finalVerifyPassed && reviewsAccepted && runComplete;
  if (!skipPR && prEligible) {
    const prTask = [
      PR_INSTRUCTIONS
        ? PR_INSTRUCTIONS
        : "Open this repo's pull/merge request for the integrated work, using the\n" +
          "command recorded in docs/agents/verification.md and the issue tracker doc.",
      ""
    ];
    prTask.push.apply(prTask, checkoutHint());
    prTask.push(
      "",
      "Branch: " + integrationBranch + " -> " + BASE_BRANCH + ", covering tickets " +
        merged.join(", ") + " (spec: " + specRef + ").",
      "The issues at " + ticketsRef + " hold the per-issue answers.",
      "Read docs/agents/issue-tracker.md for lifecycle behavior and docs/agents/verification.md for the request surface.",
      "The head branch must exist on the remote before a request can be",
      "opened — push it first (git push -u origin <branch>) if it is not there.",
      "If this repo has no request surface, leave the work on the integration branch and return exactly `NO_PR_SURFACE` on its own line.",
      "If a PR was opened, return exactly `PR_CREATED: <url>` on its own line. Report failure clearly if a PR was expected but could not be opened."
    );
    if (prWaived) {
      prTask.push(
        "This request is explicitly waived by the user, not green-gated.",
        "Open it as a draft, if this repo's request surface supports drafts, and include the waiver reason plus unresolved review findings.",
        "Waiver reason: " + PR_WAIVER_REASON,
        "Unresolved review findings: " + JSON.stringify(blockedAxes)
      );
    }
    try {
      prRun = await runs.run("pr", {
        label: "Open pull/merge request",
        agent: AG.prWriter,
        task: prTask.join("\n"),
        timeoutMs: MERGE_TIMEOUT_MS,
        control: childControl()
      });
    } catch (eP) {
      emit("implement-spec: pr run rejected (" + eP + ")");
    }
    const requestResult = parsePrWriterResult(prRun);
    prUrl = requestResult.url;
    prCreated = !!(prRun && prRun.ok && prUrl);
    prSurfaceUnavailable = !!(prRun && prRun.ok && requestResult.noPrSurface);
    prFailed = !skipPR && prEligible && !prCreated && !prSurfaceUnavailable;
    // Ready for Review begins only after a normal PR is created. A waived PR
    // stays a draft and does not advance the lifecycle status.
    if (prRun && prRun.ok && prCreated && !prWaived) {
      for (const ref of merged) {
        const transition = await runTransition("ready_for_review", ref, { branch: integrationBranch, prUrl: prUrl });
        if (!transition || !transition.ok) readyTransitionFailures.push(ref);
      }
    }
  } else if (!skipPR) {
    emit("implement-spec: PR suppressed — " +
         (!finalVerifyPassed ? "final full-suite verification failed"
           : (!runComplete ? "one or more in-scope issues are unresolved or escalated"
             : (reviewsIncomplete ? "review incomplete" : "review blockers remain without an explicit waiver"))) +
         "; lead decision needed");
  }
}

const workflowComplete = finalVerifyPassed && reviewsAccepted && runComplete && !prWaived && !prFailed &&
  readyTransitionFailures.length === 0 && (skipPR || prCreated || prSurfaceUnavailable);

// Preserve child worktrees after incomplete or waived runs so the lead can resume them.
if (REPO_PATH && workflowComplete) {
  await runs.run("cleanup-worktrees", {
    agent: AG.worker,
    label: "Clean up child worktrees",
    task: "Remove managed git worktrees under " + REPO_PATH + " that belong to " +
      "completed child runs (paths containing 'pi-worktree-').\n" +
      "1. git -C " + REPO_PATH + " worktree list --porcelain  - list all worktrees.\n" +
      "2. For each worktree path containing 'pi-worktree-', run:\n" +
      "   git -C " + REPO_PATH + " worktree remove --force <path> 2>/dev/null || true\n" +
      "3. git -C " + REPO_PATH + " worktree prune.\n" +
      "Do NOT switch branches or modify the main checkout.\n" +
      "Report WORKTREES_CLEANED with the count removed.",
    timeoutMs: 30 * 1000,
    quiet: true
  }).catch(function(e) { emit("implement-spec: worktree cleanup error: " + e); });
}

return {
  ok: workflowComplete,
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
  verifications: verifications,
  fixApplied: !!(fixRun && fixRun.ok),
  fixMerged: !!(fixMergerRun && fixMergerRun.ok),
  prCreated: prCreated,
  prSurfaceUnavailable: prSurfaceUnavailable,
  prFailed: prFailed,
  prUrl: prUrl,
  prWaived: prWaived,
  prWaiverReason: prWaived ? PR_WAIVER_REASON : null,
  finalVerifyPassed: finalVerifyPassed,
  readyTransitionFailures: readyTransitionFailures,
  prOutput: prRun && prRun.output ? prRun.output.slice(0, 400) : null
};
