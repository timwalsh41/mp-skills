// implement-spec Orchestration Workflow (remediation-ladder rewrite, 2026-10-15)
//
// Runs INSIDE the pi subagent workflow sandbox. That sandbox is a plain JS
// statement body with top-level await and NO fs/shell/require/tools — every
// action on the world goes through child agents via runs.run / runs.all.
//
// Some helpers below (numArg, boolArg, gateObj, childControl, checkoutHint,
// reviewAxisTask, classifyFailure) are
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
//   fullGateTickets    default [] = tickets use narrowGate; pass e.g.
//                      ["JRB-015"] to gate those ticket boundaries with fullGate.
//   gateTimeoutMs      default 15 min — harness gate caps are shorter than most
//                      real suites; take this number from the verification doc
//   implTimeoutMs      default 75 min per implementer/fixer/continue child
//   mergeTimeoutMs     default 20 min per merger
//   maxRemediations    default 2 remediation attempts per ticket before
//                      escalation to the lead
//   baseBranch         default "main" — what the review axes diff against and
//                      the request targets; from the verification doc
//   transitionCheckCommands REQUIRED host status commands for each phase;
//                      $TICKET_REF and $PHASE become shell-quoted values.
//   prCheckCommand     REQUIRED unless skipPR/noPrSurface; host lookup for
//                      $PR_URL on $BRANCH, exit 0 only if the PR exists.
//   mergeCheckCommand  REQUIRED for finalizeMergedPR; host check for
//                      $MERGE_REF and $TICKET_REFS (comma-separated).
//   noPrSurface        true only when repo docs explicitly rule out PRs.
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
//   repoPath           REQUIRED. The absolute path of the checkout this run
//                      integrates into. Children that work in the MAIN
//                      checkout (merger, verifier, final verify, review axes,
//                      request writer) are told where it is and told to
//                      confirm their own working directory before they
//                      conclude that a branch, a spec or a file is missing:
//                      a child that lands in the wrong directory otherwise
//                      reports a missing target, which suppresses the
//                      request and escalates a run that is actually fine.
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
//   - A review axis that returns no structured verdict is INCOMPLETE, not
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
//     │                  reporting a structured worktreePath for the merger.
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
// Config preflight errors collect here; unwrapGate (below) reports gate-arg
// violations into this array, so it must be declared before the gate args.
const configErrors = [];
const FULL_GATE = unwrapGate(A.fullGate, "fullGate");
const NARROW_GATE = unwrapGate(A.narrowGate, "narrowGate") || FULL_GATE;
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
// Gate args: accept a bare command string or a { command, timeoutMs } object;
// reject anything else with an exact, named message (JRB-016: two launches
// were burned passing objects/booleans where a string was expected, each
// surfacing only at the first child spawn minutes into the run).
function unwrapGate(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim()) return { command: value.trim(), timeoutMs: null };
  if (value && typeof value === "object" && typeof value.command === "string" && value.command.trim()) {
    return {
      command: value.command.trim(),
      timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : null
    };
  }
  configErrors.push(label + " must be a command string or { command, timeoutMs }; got " + describeArg(value));
  return null;
}

// Repo-specific args have no fallback: running a gate that does not exist in
// this repo burns a remediation cycle per ticket, and merging into a branch
// nobody named is worse. Bail before any child launches.
const missingArgs = [];
if (!specRef) missingArgs.push("specRef");
if (!ticketsRef) missingArgs.push("ticketsRef");
if (!integrationBranch) missingArgs.push("integrationBranch");
if (!finalizeMergedPR && !FULL_GATE) missingArgs.push("fullGate");
if (!A.repoPath) missingArgs.push("repoPath");
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
const TRANSITION_CHECK_COMMANDS = A.transitionCheckCommands || {};
const MERGE_CHECK_COMMAND = A.mergeCheckCommand || "";
const PR_CHECK_COMMAND = A.prCheckCommand || "";
const NO_PR_SURFACE = boolArg(A.noPrSurface);
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
        "Use the documented transition only. Do not modify code, other issues, or repository files.",
      ].join("\n");
  return runs.run("transition-" + phase + "-" + keyOf(ref), {
    agent: AG.worker,
    label: "Transition " + ref + " to " + phase,
    task: task +
      "\nRecord nothing anywhere: your ONLY write is the lifecycle transition itself." +
      " Never PATCH the ticket description, never append Agent Execution Evidence" +
      " sections, never modify repository files. Evidence is written by the" +
      " implementer and verifier children, never by a transition." +
      "\nReport the HTTP status code or error. Change nothing else.",
    timeoutMs: TRANSITION_TIMEOUT_MS,
    quiet: true,
    outputSchema: TRANSITION_OUTPUT_SCHEMA,
    // Lifecycle writes are decided by the tracker's state, not by this
    // child's prose; the outcome is read from the structured result, and no
    // acceptance report is demanded from a transition child.
    acceptance: false
  }).then(function(r) {
    const structured = (r && r.structuredOutput) || null;
    const outcome = structured && typeof structured.outcome === "string" ? structured.outcome : null;
    const unsupported = outcome === "TRANSITION_UNSUPPORTED";
    // TRANSITION_APPLIED / TRANSITION_ALREADY_SET are the only positive
    // outcomes for the requested phase. TRANSITION_FAILED and
    // TRANSITION_STATE_MISMATCH are failures. A child that never produced a
    // structured outcome counts as failed (the harness rejects it first).
    const reported = !!(r && r.ok) && (outcome === "TRANSITION_APPLIED" || outcome === "TRANSITION_ALREADY_SET");
    return (reported ? runs.run("check-transition-" + phase + "-" + keyOf(ref), {
      agent: AG.worker,
      label: "Check tracker status for " + ref,
      task: "Change nothing; the host gate checks the resulting tracker status.",
      quiet: true,
      gate: hostGate(checkedCommand(TRANSITION_CHECK_COMMANDS[phase], { TICKET_REF: ref, PHASE: phase }), TRANSITION_TIMEOUT_MS),
      agentContract: { version: 1 }, acceptance: false
    }) : Promise.resolve(null)).then(function(check) {
    const ok = reported && hostVerified(check);
    emit("implement-spec: transition " + phase + " for " + ref + " -- " + (unsupported ? "unsupported by tracker" : (ok ? "done" : "failed (" + (outcome || "no structured outcome") + ")")));
    return { ok: ok, output: String((r && r.output) || "") + (structured ? "\n[outcome] " + outcome : ""), unsupported: unsupported };
    });
  });
}
function parsePrWriterResult(result) {
  const structured = (result && result.structuredOutput) || null;
  const url = structured && typeof structured.prUrl === "string" && structured.prUrl.trim()
    ? structured.prUrl.trim() : null;
  return {
    url: url,
    noPrSurface: !!(structured && structured.noPrSurface)
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
      "Do not change issue statuses. Report the outcome through structured_output:",
      "confirmed: true when the documented process confirms the work reached its",
      "completion point, false otherwise, plus the evidence you relied on."
    ].join("\n"),
    timeoutMs: TRANSITION_TIMEOUT_MS,
    quiet: true,
    outputSchema: CONFIRM_MERGE_OUTPUT_SCHEMA,
    acceptance: false
  }).then(function(reported) {
    if (!reported || !reported.ok || !reported.structuredOutput || reported.structuredOutput.confirmed !== true) return reported;
    return runs.run("check-merge", {
      agent: AG.worker,
      label: "Check merged issues",
      task: "Change nothing; the host gate verifies the merge reference.",
      quiet: true,
      gate: hostGate(checkedCommand(MERGE_CHECK_COMMAND, { MERGE_REF: mergeRef, TICKET_REFS: refs.join(","), BRANCH: integrationBranch }), TRANSITION_TIMEOUT_MS),
      agentContract: { version: 1 }, acceptance: false
    }).then(function(check) {
      return { ok: hostVerified(check), structuredOutput: reported.structuredOutput, output: reported.output };
    });
  });
}

// Tracker-specific issue fields and lifecycle operations come from
// docs/agents/issue-tracker.md, never from hard-coded Markdown assumptions.
// A run key safe for any tracker's ticket reference (paths, #42, PROJ-123).
function keyOf(ref) { return String(ref).replace(/[^a-zA-Z0-9._-]+/g, "_"); }
function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
function checkedCommand(template, replacements) {
  let command = template;
  for (const name of Object.keys(replacements)) {
    command = command.split("$" + name).join(shellQuote(replacements[name]));
  }
  return "cd " + shellQuote(REPO_PATH) + " && (" + command + ")";
}
function cleanTreeCommand(repoPath) {
  const repo = shellQuote(repoPath);
  return "git -C " + repo + " rev-parse --is-inside-work-tree | grep -qx true && " +
    "porcelain=$(git -C " + repo + " status --porcelain) && test -z \"$porcelain\"";
}

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

// Structured verdict contracts for judgment children (reviews, verification,
// the PR writer) travel with the agent definitions: agents/reviewer-*.md,
// agents/verifier.md and agents/pr-writer.md carry the schema in frontmatter,
// so EVERY spawn — orchestrator-driven or an ad-hoc lead continuation — is
// provisioned with the harness's structured_output tool, and the workflow
// reads result.structuredOutput without ever parsing child prose. Do not pass
// a run-level outputSchema for those children here: a second schema source is
// drift, and a forgotten one is how JRB-018's manually re-spawned reviewer
// ended up with no structured_output tool at all. Worker lifecycle children
// keep run-level schemas below because the generic worker agent stays
// schema-free. (JRB-016/JRB-017: prose token parsing rejected green children
// and misread compliance statements.)
const TRANSITION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["TRANSITION_APPLIED", "TRANSITION_ALREADY_SET", "TRANSITION_FAILED", "TRANSITION_UNSUPPORTED", "TRANSITION_STATE_MISMATCH"]
    },
    resultingStatus: { type: "string" },
    detail: { type: "string" }
  },
  required: ["outcome"],
  additionalProperties: false
};
const CONFIRM_MERGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    confirmed: { type: "boolean" },
    evidence: { type: "string" }
  },
  required: ["confirmed"],
  additionalProperties: false
};
const WORKTREE_PATH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    worktreePath: { type: "string" }
  },
  required: ["worktreePath"],
  additionalProperties: false
};
const GRAPH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    tickets: { type: "array", items: {
      type: "object",
      properties: {
        ref: { type: "string" }, title: { type: "string" }, type: { type: "string" },
        resolved: { type: "boolean" }, blockedBy: { type: "array", items: { type: "string" } },
        onBranch: { type: "boolean" }, groomed: { type: "boolean" }
      },
      required: ["ref", "title", "resolved", "blockedBy", "onBranch", "groomed"],
      additionalProperties: false
    } },
    preflight: { type: "object", properties: {
      trackerConfigured: { type: "boolean" }, integrationBranchExists: { type: "boolean" },
      integrationBranch: { type: "string" }
    }, required: ["trackerConfigured", "integrationBranchExists", "integrationBranch"], additionalProperties: false }
  },
  required: ["tickets", "preflight"], additionalProperties: false
};
const FLAKE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["FLAKE_CONFIRMED_TRANSIENT", "FLAKE_PERSISTENT", "WORKTREE_NOT_FOUND"] },
    testPath: { type: "string" },
    detail: { type: "string" }
  },
  required: ["outcome"],
  additionalProperties: false
};
const REVIEW_VERDICTS = ["OK", "BLOCK", "MISSING_TARGET"];

const IMPL_TIMEOUT_MS = numArg(A.implTimeoutMs, 75 * 60 * 1000);
const MERGE_TIMEOUT_MS = numArg(A.mergeTimeoutMs, 20 * 60 * 1000);
// The harness default gate cap is 120s, under the real
// suite runtime. EVERY gate must carry an explicit generous deadline — so
// children get the launch object, never a bare command string.
const GATE_TIMEOUT_MS = numArg(A.gateTimeoutMs, 15 * 60 * 1000);
const MAX_REMEDIATIONS = numArg(A.maxRemediations, 2);
const MAX_REVIEW_RETRIES = numArg(A.maxReviewRetries, 2);
// Transitions and merge confirmation are short, scripted lifecycle steps, but
// their default tasks read the tracker docs before acting, and 60s proved too
// tight whenever a child did anything beyond two HTTP calls (JRB-014: a
// transition child spent its budget and aborted the whole run). Hardcoded on
// purpose: a lifecycle step should never need per-repo tuning.
const TRANSITION_TIMEOUT_MS = 3 * 60 * 1000;

// Gate commands are args-only (declared once above, unwrapped from strings
// or { command, timeoutMs } objects).
const fullGateTickets = A.fullGateTickets || [];
function gateObj(command, timeoutMs) { return { command: command, timeoutMs: timeoutMs || GATE_TIMEOUT_MS }; }
function hostGate(command, timeoutMs) {
  return {
    command: "(" + command + ") 1>&2 && printf '{\"verified\":true}\\n'",
    output: "json",
    schema: { type: "object", properties: { verified: { type: "boolean", const: true } }, required: ["verified"], additionalProperties: false },
    timeoutMs: timeoutMs || GATE_TIMEOUT_MS
  };
}
function hostVerified(result) {
  return !!(result && result.ok && result.structuredOutput && result.structuredOutput.verified === true);
}
function gateFor(ref) {
  const selected = fullGateTickets.indexOf(ref) >= 0 ? FULL_GATE : NARROW_GATE;
  return gateObj(selected.command, selected.timeoutMs);
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
for (const phase of finalizeMergedPR ? ["complete"] : (skipPR || NO_PR_SURFACE ? ["in_progress"] : ["in_progress", "ready_for_review"])) {
  if (typeof TRANSITION_CHECK_COMMANDS[phase] !== "string" || !TRANSITION_CHECK_COMMANDS[phase].trim()) {
    configErrors.push("transitionCheckCommands." + phase + " must be a host command verifying the issue's resulting status");
  }
}
if (finalizeMergedPR && !MERGE_CHECK_COMMAND) configErrors.push("mergeCheckCommand must verify the merge reference on the host");
if (!finalizeMergedPR && !skipPR && !NO_PR_SURFACE && !PR_CHECK_COMMAND) configErrors.push("prCheckCommand must verify the created request on the host");
if (configErrors.length) {
  return {
    ok: false,
    error: "implement-spec config error: " + configErrors.join("; ") +
      ". No child was launched. Fix the args and relaunch.",
    configError: true
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
      " gates=[full: " + (FULL_GATE && FULL_GATE.command) + "]" +
      (FULL_GATE && NARROW_GATE && NARROW_GATE.command !== FULL_GATE.command ? " [narrow: " + NARROW_GATE.command + "]" : "") +
      " gateTimeoutMs=" + GATE_TIMEOUT_MS +
      " maxRemediations=" + MAX_REMEDIATIONS +
      (verifyOnly ? " verifyOnly" : "") +
      (skipPR ? " skipPR" : ""));

// ---------------------------------------------------------------------------
// Helpers — plain functions returning promises ONLY (nested async is
// rejected by workflow validation).
// ---------------------------------------------------------------------------

// Wave 0/per-wave discovery child: enumerate the complete issue graph.
// A partial or truncated document is never treated as an authoritative scope.
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
    "Include type when available. If any issue in this target cannot be read,",
    "do NOT return an incomplete graph: report the failure instead.",
    "",
    "Preflight, reported in the same JSON document:",
    "  trackerConfigured: true when a usable issue tracker is configured; if",
    "  not, report false and stop.",
    "  integrationBranchExists: run `git rev-parse --verify " + baseRef + "` and",
    "  report true only if it exits 0; integrationBranch: the name you tested.",
    "  Report only. Never create, fetch, switch to, or merge that branch.",
    "",
    "Finish by calling structured_output with tickets (the full target scope)",
    "and preflight. Do not report partial discoveries as complete."
  ].join("\n");
  return runs.run(fresh ? "ticket-graph-forced" : "ticket-graph", {
    label: "Read ticket graph from " + ticketsRef,
    agent: AG.scout,
    task: task,
    timeoutMs: 10 * 60 * 1000,
    quiet: true,
    outputSchema: GRAPH_OUTPUT_SCHEMA,
    acceptance: false
  });
}

function preflightFromGraph(result) {
  return result && result.ok && result.structuredOutput ? result.structuredOutput.preflight : null;
}
function statusesFromGraph(result) {
  return result && result.ok && result.structuredOutput &&
    Array.isArray(result.structuredOutput.tickets) ? result.structuredOutput.tickets : [];
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
    "- Record your implementation report under `## Agent Execution Evidence` / `### Implementation` in the ticket description, following docs/agents/issue-tracker.md.",
    "  Reconcile, never append: fetch the current description first; if a `### Implementation`",
    "  section already exists, replace/merge it in place — one section, latest content, with a",
    "  timestamp. Never duplicate section headers.",
    "- Do not change lifecycle status; the orchestrator owns In Progress and Ready for Review transitions, and Complete is post-merge only.",
    "- Write/update tests for every criterion (unit/integration/E2E per spec); trace shared files to other callers and protect adjacent workflows.",
    "- Your tree already branches from " + integrationBranch + "; do NOT create",
    "  branches, worktrees, or spawn subagents.",
    "- Do NOT run git commit — leave your changes uncommitted in the worktree;",
    "  the orchestrator captures and merges them.",
    "- If the repo configures a pre-commit formatter (check .pre-commit-config.yaml and the format command in docs/agents/verification.md or CODING_STANDARDS.md), run it over the files you changed before finishing, then re-run the gate. The merger's commit-time pre-commit hook reformats anything left unformatted, and the captured patch must already be in the form that lands (JRB-018).",
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
    "4. Run the repo's configured pre-commit formatter over the files you changed before finishing (see .pre-commit-config.yaml; the command is in docs/agents/verification.md or CODING_STANDARDS.md) — the merger's commit-time hook reformats anything left unformatted (JRB-018).",
    "5. Leave changes uncommitted. Do NOT commit, stage, or spawn subagents.",
    "",
    "Finish by calling structured_output with worktreePath: the absolute path of",
    "the worktree you worked in, so the orchestrator can hand it to the merger."
  ].join("\n");
  return runs.run(key, {
    label: "Continue ticket " + ticket.ref + " (finish timed-out work in place)",
    agent: AG.implementer,
    task: task,
    timeoutMs: IMPL_TIMEOUT_MS,
    gate: gateFor(ticket.ref),
    control: childControl(),
    outputSchema: WORKTREE_PATH_OUTPUT_SCHEMA
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
  const asyncDir = result.asyncDir || paths.find(function(p) {
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
    "5. Run the repo's configured pre-commit formatter (see .pre-commit-config.yaml; the command is documented in docs/agents/verification.md or CODING_STANDARDS.md) over the files you changed before finishing, then re-run the gate: the merger's commit-time hook reformats anything left unformatted (JRB-018).",
    "6. Re-run the gate until green, then finish with the acceptance-report block.",
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
// Merger gate body, shared with implement/orchestrate.js (duplicated because
// the workflow sandbox cannot import modules). Proves on the host: right
// branch, clean tree, the captured patch's content is on the branch, issue
// trailers exist, and the suite is green. Every clause labels its own failure
// on stderr, so an escalation names the exact failed check instead of a bare
// exit code (JRB-018: a five-clause && chain produced one opaque failure and
// forced manual forensics).
//
// The patch check is formatter-tolerant: a repo pre-commit hook (ruff-format
// et al.) rewrites staged files at commit time, so the captured patch never
// textually reverse-applies to the commit even though the work landed. The
// gate walks the first-parent chain from HEAD down to the merge-base with
// the base branch (capped), and for each commit C checks whether applying
// the patch to a temp index seeded from C's parent yields a tree equal to
// C's modulo whitespace. That passes when the work is committed (exactly,
// hook-reformatted, or already merged as a verified no-op), including when
// sibling commits landed after it in a multi-ticket wave, and fails when it
// is absent — the no-op success path JRB-018's second merger was denied.
function mergerGateBody(patchPrologue, issueRefs, testCommand) {
  const body = [
    "fail() { echo 'MERGE_GATE_FAIL:' \"$1\" >&2; exit 1; }",
    "cd " + shellQuote(REPO_PATH) + " || fail \"cannot enter checkout " + REPO_PATH + "\"",
    "test \"$(git branch --show-current)\" = " + shellQuote(integrationBranch) +
      " || fail \"checkout is on '$(git branch --show-current)', expected " + integrationBranch + "\"",
    "test -z \"$(git status --porcelain)\" || fail \"checkout has uncommitted or untracked changes\""
  ];
  if (!patchPrologue) {
    // Never search another run's patch by filename or ticket label.
    body.push("fail \"no captured patch is attributable to this run\"");
  } else {
    body.push(patchPrologue);
    body.push([
      "work_on_branch=''",
      "mb=$(git merge-base HEAD " + shellQuote(BASE_BRANCH) + " 2>/dev/null || true)",
      "c=HEAD",
      "i=0",
      "while [ \"$i\" -le 12 ]; do",
      "  if [ \"$i\" -gt 0 ]; then",
      "    c=$(git rev-parse -q --verify \"HEAD~$i\" 2>/dev/null) || break",
      "  fi",
      "  test -n \"$c\" || break",
      "  parent=$(git rev-parse -q --verify \"$c^\" 2>/dev/null || true)",
      "  if test -n \"$parent\"; then",
      "    tidx=$(mktemp) && rm -f \"$tidx\"",
      "    if GIT_INDEX_FILE=\"$tidx\" git read-tree \"$parent\" 2>/dev/null &&",
      "       GIT_INDEX_FILE=\"$tidx\" git apply --cached --whitespace=fix \"$pfile\" 2>/dev/null; then",
      "      ptree=$(GIT_INDEX_FILE=\"$tidx\" git write-tree 2>/dev/null)",
      "      rm -f \"$tidx\"",
      "      if test -n \"$ptree\"; then",
      "        tlist=$(mktemp)",
      "        git diff --name-only -z \"$ptree\" \"$c\" | tr '\\0' '\\n' > \"$tlist\" 2>/dev/null",
      "        equiv=1",
      "        while IFS= read -r p; do",
      "          test -n \"$p\" || continue",
      "          a=$(git show \"$ptree:$p\" 2>/dev/null | tr -d '[:space:]')",
      "          b=$(git show \"$c:$p\" 2>/dev/null | tr -d '[:space:]')",
      "          if ! test \"$a\" = \"$b\"; then equiv=''; break; fi",
      "        done < \"$tlist\"",
      "        rm -f \"$tlist\"",
      "        test -n \"$equiv\" && work_on_branch=1 && break",
      "      fi",
      "    else",
      "      rm -f \"$tidx\"",
      "    fi",
      "  fi",
      "  test \"$c\" = \"$mb\" && break",
      "  i=$((i+1))",
      "done",
      "test -n \"$work_on_branch\" || fail \"captured patch is not on " + integrationBranch +
        ": no commit from HEAD down to the merge-base equals parent+patch modulo whitespace; branch delta: $(git diff --stat \"$(git merge-base HEAD " + shellQuote(BASE_BRANCH) + ")\" HEAD | tail -1)\""
    ].join("\n"));
  }
  for (const issueRef of issueRefs) {
    body.push("git log --format=%B " + shellQuote(BASE_BRANCH + "..HEAD") +
      " | grep -Fxq " + shellQuote("Issue: " + issueRef) +
      " || fail \"no commit on " + integrationBranch + " carries the 'Issue: " + issueRef + "' trailer\"");
  }
  body.push("(" + testCommand + ") || fail \"verification command failed on " + integrationBranch + "\"");
  return body.join("\n");
}
function mergeGate(ref, result, worktreePath, affectedRefs) {
  const hint = patchHint(result);
  let prologue = null;
  if (worktreePath) {
    prologue = [
      "pfile=$(mktemp)",
      "git -C " + shellQuote(worktreePath) + " diff HEAD --no-ext-diff > \"$pfile\" 2>/dev/null || fail \"could not capture diff from worktree " + worktreePath + "\"",
      "test -s \"$pfile\" || { rm -f \"$pfile\"; fail \"worktree " + worktreePath + " has no uncommitted changes to capture\"; }"
    ].join("\n");
  } else if (hint.dir) {
    prologue = [
      "set -- " + shellQuote(hint.dir) + "/*.patch",
      "test \"$#\" -eq 1 && test -f \"$1\" || fail \"expected exactly one captured patch in " + hint.dir + ", found $#\"",
      "pfile=$1"
    ].join("\n");
  }
  return hostGate(mergerGateBody(prologue, affectedRefs || [ref], gateCommand(ref)), GATE_TIMEOUT_MS);
}
function spawnMerger(ticket, implResult, wave, worktreePath, attempt) {
  const hint = patchHint(implResult);
  const key = "merge-" + wave + "-t" + keyOf(ticket.ref) + "-attempt-" + attempt;
  const gate = mergeGate(ticket.ref, implResult, worktreePath);
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
    "1. Confirm the main checkout is clean (git status). If it is on " + BASE_BRANCH,
    "   check out " + integrationBranch + " then confirm it is still clean. If it",
    "   is on neither branch, or dirty, STOP and report.",
    "2. CONTENT-BASED IDEMPOTENCY CHECK. This decides whether the work is already",
    "   merged. Run: git apply --check --reverse <patch>",
    "   Exit 0 means the captured patch is ALREADY applied to this branch: do NOT",
    "   apply or commit; report that the merge was already done, with the existing",
    "   commit hash, and exit successfully — the host gate verifies content",
    "   equivalence while ignoring whitespace-only differences, so a formatting",
    "   pre-commit hook cannot make a verified no-op fail (JRB-018). A non-zero",
    "   exit usually means it is NOT applied: continue. But if the patch will not",
    "   forward-apply either (its content is already committed and possibly",
    "   reformatted), verify content equivalence yourself: apply the patch to a",
    "   temp index or worktree at a candidate base (merge-base HEAD " + BASE_BRANCH + ", or the",
    "   parent of the existing ticket commit) and compare with HEAD using",
    "   git diff -w; if the content matches, treat it as already merged and report",
    "   the existing commit hash without committing anything.",
    "   Never decide this from `Issue:` trailer grep or `git log --grep`:",
    "   a trailer proves only that some commit for this ticket exists, not that",
    "   THIS patch is applied (JRB-017: a fix merge was skipped because the",
    "   implementation commit already carried the trailer).",
    "3. Apply the implementer's changes (per the source above). If the patch is",
    "   empty or missing, stop; an already-applied patch was handled in step 2.",
    "4. Read the issue and diff, then create a Conventional Commit subject using the appropriate type and a concise change summary. Include `Issue: " + ticket.ref + "` as a commit-body trailer. Do not use a generic 'Implement ticket' subject.",
    "5. Commit using that subject and trailer, then validate both:",
    "   git log -1 --format=%s | grep -Eq '^[a-z][a-z0-9-]*(\\([a-z0-9._/-]+\\))?!?: .+'",
    "   git show -s --format=%B HEAD | grep -Fx 'Issue: " + ticket.ref + "'",
    "   If either check fails, amend only the message and re-check.",
    "6. Do NOT delete branches or run any worktree-manager commands.\n    (The verification gate runs on the host automatically; do not run it yourself.)",
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
    agentContract: { version: 1 },
    control: childControl(),
    // Merger success is decided by the host-run gate and the commit state;
    // acceptance: false keeps the harness from rejecting a green merge
    // because no acceptance-report block was found in the output (JRB-016).
    acceptance: false
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
    "Record verification evidence under `## Agent Execution Evidence` / `### Independent Verification`",
    "in the ticket description, following docs/agents/issue-tracker.md. Reconcile, never append:",
    "fetch the description first; replace/merge your own section in place (one section, latest",
    "content, timestamped; never duplicate headers), and CORRECT stale or contradictory prior",
    "evidence in place — a stale note left behind is a defect, not a cosmetic issue. Include",
    "file paths, test names, commands run, and any gap. Do not change lifecycle",
    "status or acceptance outcomes. Trace shared-file consumers and verify affected adjacent workflows too.",
    "",
    "Rules:",
    "- Touch only this ticket. Do NOT edit code, do NOT commit, do NOT change",
    "  git state, do NOT spawn subagents.",
    "",
    "Finish by calling structured_output:",
    "- verdict: OK when every criterion is satisfied, UNMET when at least one is not;",
    "- criteria: one entry per criterion (criterion, satisfied, evidence);",
    "- unmet: when verdict is UNMET, name the unmet criteria.",
    "A missing or malformed structured verdict is treated as NOT verified."
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
function verificationVerdictOf(result) {
  const structured = (result && result.structuredOutput) || null;
  return structured && (structured.verdict === "OK" || structured.verdict === "UNMET")
    ? structured.verdict : "UNVERDICTED";
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
    "checkout and review that instead. Trace changed shared files to their other",
    "callers and verify adjacent workflows and cross-ticket interactions.",
    "In that case answer with verdict MISSING_TARGET (name what was absent in",
    "missingTarget) and stop.",
    "",
    "Report concrete findings with file:line references, then call structured_output:",
    "- verdict: OK (no must-fix defects), BLOCK (must-fix defects exist), or",
    "  MISSING_TARGET (the target named above does not resolve).",
    "- findings: a summary of your concrete findings (empty or omitted when none).",
    "No other verdict is a pass; a missing or malformed structured verdict is an",
    "unfinished review."
  );
  return task.join("\n");
}
function reviewRecord(axis, result) {
  const output = String((result && result.output) || "");
  const structured = (result && result.structuredOutput) || null;
  const verdict = structured && REVIEW_VERDICTS.indexOf(structured.verdict) >= 0
    ? structured.verdict : "UNVERDICTED";
  return {
    axis: axis,
    ok: !!(result && result.ok),
    verdict: result && result.ok ? verdict : "UNVERDICTED",
    findings: structured && typeof structured.findings === "string" ? structured.findings.slice(0, 2000) : null,
    excerpt: output.slice(0, 4000),
    error: result && result.error ? String(result.error) : null
  };
}

function spawnReviews(stage, wave) {
  return Promise.all(REVIEW_AXES.map(function(a) {
    const key = "review-" + stage + "-" + a.name + "-" + wave;
    return Promise.resolve().then(function() {
      return runs.run(key, {
        label: "Review " + a.name + " axis (" + stage + ")",
        agent: a.agent,
        task: reviewAxisTask(a.name, a.focus),
        timeoutMs: MERGE_TIMEOUT_MS,
        control: childControl()
      });
    }).then(function(result) {
      return reviewRecord(a.name, result);
    }).catch(function(error) {
      return reviewRecord(a.name, { ok: false, error: String(error), output: "" });
    });
  }));
}

function respawnReview(stage, wave, axis, attempt) {
  const cfg = REVIEW_AXES.filter(function(a) { return a.name === axis; })[0];
  return runs.run("review-" + stage + "-" + axis + "-" + wave + "-retry-" + attempt, {
    label: "Review " + axis + " axis (" + stage + " retry " + attempt + ")",
    agent: cfg.agent,
    task: reviewAxisTask(axis, cfg.focus),
    timeoutMs: MERGE_TIMEOUT_MS,
    control: childControl()
  });
}

function retryUnverdicts(stage, wave, reviews, attempt) {
  const retryAxes = reviews.filter(function(review) { return review.verdict === "UNVERDICTED"; });
  if (!retryAxes.length || attempt >= MAX_REVIEW_RETRIES) return Promise.resolve(reviews);
  const nextAttempt = attempt + 1;
  emit("implement-spec: retrying UNVERDICTED review axes: " +
       retryAxes.map(function(review) { return review.axis; }).join(", ") +
       " (attempt " + nextAttempt + "/" + MAX_REVIEW_RETRIES + ")");
  return Promise.all(retryAxes.map(function(review) {
    return Promise.resolve().then(function() {
      return respawnReview(stage, wave, review.axis, nextAttempt);
    }).then(function(result) {
      return reviewRecord(review.axis, result);
    }).catch(function(error) {
      return reviewRecord(review.axis, { ok: false, error: String(error), output: "" });
    });
  })).then(function(retries) {
    retries.forEach(function(retry) {
      const index = reviews.findIndex(function(review) { return review.axis === retry.axis; });
      reviews[index] = retry;
    });
    return retryUnverdicts(stage, wave, reviews, nextAttempt);
  });
}

function runReviewPhase(stage, wave) {
  return spawnReviews(stage, wave).then(function(reviews) {
    return retryUnverdicts(stage, wave, reviews, 0);
  });
}

function summarizeReviews(reviews) {
  const blockedAxes = reviews.filter(function(review) { return review.verdict === "BLOCK"; });
  const unreviewedAxes = reviews.filter(function(review) {
    return review.verdict !== "BLOCK" && review.verdict !== "OK";
  });
  return {
    blockedAxes: blockedAxes,
    unreviewedAxes: unreviewedAxes,
    reviewsIncomplete: reviews.length < REVIEW_AXES.length || unreviewedAxes.length > 0
  };
}

// ---------------------------------------------------------------------------
// Per-ticket ledger + failure classification
// ---------------------------------------------------------------------------
const ledger = {};   // ticket number -> { attempts, state, runId, lastError }
function ledgerFor(num) {
  if (!ledger[num]) ledger[num] = { attempts: 0, state: "pending", runId: null, lastError: null, lastSignature: null };
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

// Normalizes a failure into a comparable signature: run IDs, absolute paths,
// and numbers are stripped so the same root cause matches across remediation
// attempts (JRB-014: three identical worktree-admission failures burned the
// whole ladder before escalating).
function failureSignature(result) {
  return String((result && (result.error || result.output)) || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\/[\w.@+-]+(?:\/[\w.@+-]+)+/g, "<path>")
    .replace(/\d{2,}/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
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
    "4. If it passes, report the exact test path and the outcome FLAKE_CONFIRMED_TRANSIENT.",
    "5. If it fails again, report FLAKE_PERSISTENT and the failure detail.",
    "",
    "Do NOT modify any files. Do NOT run the full suite. Do NOT commit, create",
    "branches or worktrees, or spawn subagents.",
    "",
    "Finish by calling structured_output with outcome:",
    "FLAKE_CONFIRMED_TRANSIENT | FLAKE_PERSISTENT | WORKTREE_NOT_FOUND, plus",
    "testPath (the failing test's own path/name) and detail."
  ].join("\n");
  return runs.run(key, {
    label: "Flake recheck ticket " + ticket.ref + " (in the failed run's worktree)",
    agent: AG.implementer,
    task: task,
    timeoutMs: 15 * 60 * 1000,
    outputSchema: FLAKE_OUTPUT_SCHEMA
  });
}

// Because the tracker is the source of truth and can be updated by 
// implementers (status flips) and mergers (patch application), we must
// refresh the graph when a ticket may have changed, but not on every single
// wave start. We cache the last-read result and only force a re-fetch after
// a merger commits changes to the
// integration branch.
let ticketGraphCache = null;
function getTicketGraph(forceDiscovery) {
  if (ticketGraphCache && !forceDiscovery) {
    emit("ticket graph: reused cached discovery (ticketsRef unchanged since last read)");
    return Promise.resolve(ticketGraphCache);
  }
  return readTicketGraph(forceDiscovery).then(function(result) {
    ticketGraphCache = result;
    return result;
  });
}

// The continue-child reports its retained worktree through structured output.
function extractWorktreePath(result) {
  const structured = (result && result.structuredOutput) || null;
  const p = structured && typeof structured.worktreePath === "string" ? structured.worktreePath.trim() : "";
  return p || null;
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
if (!graphOk || !tickets.length || !preflightFromGraph(graphRun) ||
    new Set(tickets.map(function(t) { return String(t.ref); })).size !== tickets.length) {
  return {
    ok: false,
    error: "ticket discovery is missing, incomplete, duplicated, or found no tickets for " + ticketsRef
      + (graphOk
          ? ""
          : " (the discovery run itself failed"
            + (graphRun && graphRun.error ? ": " + String(graphRun.error).slice(0, 300) : "")
            + ")")
      + ". Check the target against docs/agents/issue-tracker.md and relaunch.",
    discoveryRunId: graphRun && graphRun.runId
  };
}

// Pre-flight: the checkout must be clean before any worktree child launches.
// A dirty parent checkout fails worktree admission, and in a multi-wave run
// that can burn the remediation ladder for many tickets at once (JRB-014:
// three identical admission failures from two untracked leftover files).
// Fail loudly here instead and let the user resolve the tree.
if (!finalizeMergedPR) {
  if (!REPO_PATH) {
    emit("implement-spec: WARNING - no repoPath arg; the clean-tree preflight cannot run");
  } else {
    const cleanTreePreflight = await runs.run("preflight-clean-tree", {
      agent: AG.worker,
      label: "Preflight: verify clean checkout",
      task: "Change nothing and run nothing: the host gate performs this check.\n" +
        "The gate fails when the checkout " + REPO_PATH + " has uncommitted or untracked changes.",
      timeoutMs: 30 * 1000,
      quiet: true,
      // The tree state is a deterministic host fact. The gate decides, so a
      // child's prose can never misreport it (JRB-014/JRB-016 class).
      gate: hostGate(cleanTreeCommand(REPO_PATH), 30 * 1000),
      agentContract: { version: 1 }, acceptance: false
    });
    if (!hostVerified(cleanTreePreflight)) {
      return {
        ok: false,
        dirtyTree: true,
        error: "DIRTY_TREE: the checkout " + REPO_PATH + " has uncommitted or untracked changes. " +
          "Resolve them manually (commit, stash, or remove) and relaunch. No child work started." +
          (cleanTreePreflight && cleanTreePreflight.error ? "\nGate detail: " + String(cleanTreePreflight.error).slice(0, 2000) : ""),
        discoveredTickets: tickets.length
      };
    }
    emit("implement-spec: preflight clean-tree check passed");
  }
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
if (!finalizeMergedPR) {
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
      " -> if it succeeds, done.\n" +
      "2. If it fails: git -C " + REPO_PATH + " branch " + integrationBranch + " " + BASE_BRANCH +
      " && git -C " + REPO_PATH + " push -u origin " + integrationBranch + ".\n" +
      "3. Change nothing else. Do not switch branches or modify files.\n" +
      "The host gate re-checks the branch after your run.",
    timeoutMs: 30 * 1000,
    quiet: true,
    // The branch's existence is a deterministic host fact: the gate verifies
    // it after the child runs, so no reported token is trusted.
    gate: hostGate("git -C " + shellQuote(REPO_PATH) + " rev-parse --verify " + shellQuote(baseRef), 30 * 1000),
    agentContract: { version: 1 }, acceptance: false
  });
  if (!hostVerified(ensureRun)) {
    return {
      ok: false,
      error: "implement-spec: could not create integration branch '" + integrationBranch + "' from " +
        BASE_BRANCH + ". Worktree children branch from it and would all fail. Fix the checkout and relaunch." +
        (ensureRun && ensureRun.error ? " Gate detail: " + String(ensureRun.error).slice(0, 1000) : ""),
      preflight: preflight,
      discoveredTickets: tickets.length
    };
  }
  emit("implement-spec: integration branch '" + integrationBranch + "' ensured (gate verified)");
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
  const mergeConfirmed = !!(confirmation && confirmation.ok &&
    confirmation.structuredOutput && confirmation.structuredOutput.confirmed === true);
  if (!mergeConfirmed) {
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
    if (!statusRun || !statusRun.ok || !preflightFromGraph(statusRun) || !statuses.length ||
        statuses.length !== order.length ||
        order.some(function(ref) { return !statuses.some(function(s) { return String(s.ref) === ref; }); })) {
      return { ok: false, error: "Issue discovery is incomplete or its scope changed; refusing to implement a partial graph.", integrationBranch: integrationBranch, merged: merged };
    }
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

    // Observe every launched child exactly once. Reusing a workflow key returns
    // its original receipt, so never retry a failed batch by relaunching its
    // siblings under the same keys (or lose their completed work).
    const implResults = await Promise.all(batch.map(function(ticket) {
      return spawnImplementer(ticket, wave).catch(function(error) {
        return { ok: false, error: String(error) };
      });
    }));

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
        // Identical-failure dedup: if this failure's normalized signature
        // matches the previous attempt's, retrying is pointless — escalate
        // immediately instead of burning the remaining ladder (JRB-014: three
        // identical admission failures consumed maxRemediations).
        const sig = failureSignature(implResult);
        if (ld.lastSignature && ld.lastSignature === sig) {
          escalate(ticket.ref, "IDENTICAL failure signature repeated — further remediation is pointless (" + cls + ")",
                   "runId=" + ld.runId + " lastError=" + ld.lastError);
          ld.state = "escalated";
          escalated.push(ticket.ref);
          continue;
        }
        ld.lastSignature = sig;
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
            const wt = extractWorktreePath(remediated);
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
            const flakeOutcome = flakeResult && flakeResult.structuredOutput ? flakeResult.structuredOutput.outcome : null;
            if (flakeResult && flakeResult.ok && flakeOutcome === "FLAKE_CONFIRMED_TRANSIENT") {
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
          mergeRun = await spawnMerger(ticket, implResult, wave, ld.worktreePath || null, attempt + 1);
        } catch (e2) {
          mergeErr = String(e2);
          emit("ticket " + ticket.ref + ": merger run rejected (" + e2 + ")");
        }
        if (hostVerified(mergeRun)) break;
        if (attempt === 0) emit("ticket " + ticket.ref + ": merge failed; one idempotent merger retry");
      }
      if (hostVerified(mergeRun)) {
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
        const verdict = (verifyRun && verifyRun.ok) ? verificationVerdictOf(verifyRun) : "UNVERDICTED";
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
    const verdict = (verifyRun && verifyRun.ok) ? verificationVerdictOf(verifyRun) : "UNVERDICTED";
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
  reviews = await runReviewPhase("initial", waveCount);
  let reviewSummary = summarizeReviews(reviews);
  let blockedAxes = reviewSummary.blockedAxes;
  let unreviewedAxes = reviewSummary.unreviewedAxes;
  reviewsIncomplete = reviewSummary.reviewsIncomplete;

  if (reviewsIncomplete) {
    const detail = unreviewedAxes.map(function(r) { return r.axis + ":" + r.verdict; });
    emit("ESCALATION: review is INCOMPLETE" +
         (detail.length ? " — axes without a verdict: " + detail.join(", ")
                        : " — only " + reviews.length + " of 3 axes returned") +
         ". An axis with no structured verdict is not a pass. PR suppressed; rerun the incomplete review. Incomplete reviews cannot be waived.");
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
      integrationBranch + "), keep the intermediate gate green (" + (NARROW_GATE && NARROW_GATE.command) + "), and do NOT",
      "commit — the orchestrator captures and merges your patch. Do NOT spawn",
      "subagents. End with the acceptance-report block.",
      "Run the repo's configured pre-commit formatter over the files you changed before finishing (see .pre-commit-config.yaml; the command is in docs/agents/verification.md or CODING_STANDARDS.md), then re-run the gate: the merger's commit-time hook reformats anything left unformatted (JRB-018)."
    ].join("\n");
    try {
      fixRun = await runs.run("fix-review-findings", {
        label: "Fix review blockers (worktree-isolated)",
        agent: AG.implementer,
        task: fixBrief,
        worktree: true,
        baseRef: baseRef,
        timeoutMs: IMPL_TIMEOUT_MS,
        gate: gateFor(merged[0]),
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
        "1. Confirm the main checkout is clean and on " + integrationBranch + ".",
        "   If it is clean and on " + BASE_BRANCH + ", check out " + integrationBranch +
          " and recheck. If dirty or on another branch, STOP.",
        "2. CONTENT-BASED IDEMPOTENCY CHECK. Run: git apply --check --reverse <patch>",
        "   Exit 0 means the fix patch is ALREADY applied to this branch: do NOT apply",
        "   or commit; report that the merge was already done, with the existing commit",
        "   hash, and exit successfully — the host gate verifies content equivalence",
        "   while ignoring whitespace-only differences, so a formatting pre-commit",
        "   hook cannot make a verified no-op fail (JRB-018). A non-zero exit usually",
        "   means it is NOT applied: continue; if the patch will not forward-apply",
        "   either, verify content equivalence as in the merger instructions (temp",
        "   index/worktree at a candidate base, then git diff -w against HEAD) and",
        "   treat a match as already merged. Never decide this from `Issue:` trailer",
        "   grep or `git log --grep`",
        "   (JRB-017: a fix merge was skipped because an earlier commit for the same",
        "   ticket already carried the trailer).",
        "3. Locate and apply the captured patch (git apply --whitespace=fix --index <patch>).",
        "3. Commit with a Conventional Commit subject whose type matches the fixes, such as `fix: address review findings`, and include `Issue: <ref>` trailers for each affected issue in this run: " + merged.join(", ") + ".",
        "4. Validate the subject with `git log -1 --format=%s | grep -Eq '^[a-z][a-z0-9-]*(\\([a-z0-9._/-]+\\))?!?: .+'` and validate the Issue trailers for the affected issues in this run: " + merged.join(", ") + ".",
        "   If either check fails, amend only the message and re-check.",
        "5. The orchestrator runs the intermediate gate on the host automatically: " + (NARROW_GATE && NARROW_GATE.command),
        "6. Return: merge status, commit hash, gate result."
      );
      try {
        fixMergerRun = await runs.run("merge-review-fixes", {
          label: "Commit and merge review fixes into " + integrationBranch,
          agent: AG.merger,
          task: fixMergeTask.join("\n"),
          timeoutMs: MERGE_TIMEOUT_MS,
          gate: mergeGate(merged[0], fixRun, null, merged),
          agentContract: { version: 1 },
          control: childControl(),
          // Merger success is decided by the host-run gate and the commit
          // state; no acceptance report is required (JRB-016).
          acceptance: false
        });
      } catch (eM) {
        emit("implement-spec: merge-review-fixes rejected (" + eM + ")");
      }
      if (!hostVerified(fixMergerRun)) {
        // A merger may fail after committing. Recheck the captured patch,
        // issue commits and tests on the host before treating it as merged.
        const gmVerify = await runs.run("verify-fix-merge-" + keyOf(merged[0]), {
          agent: AG.worker,
          label: "Verify fix-merge git state for " + merged.join(", "),
          task: "The merge-review-fixes child reported failure, but its work may already be committed. " +
            "Confirm: (1) checkout is on " + integrationBranch + " and clean; " +
            "(2) the fixer's changes are present (git log --oneline main.." + integrationBranch +
            " shows commits beyond the original implementation); (3) the intermediate gate " + (NARROW_GATE && NARROW_GATE.command) +
            " passes. The host gate checks the captured patch, issue commits, " +
            "and test command; your output is diagnostic only. " + checkoutHint(),
          timeoutMs: MERGE_TIMEOUT_MS,
          gate: mergeGate(merged[0], fixRun, null, merged),
          agentContract: { version: 1 },
          control: childControl(),
          acceptance: false
        }).catch(function(e) {
          emit("implement-spec: fix-merge verification rejected (" + e + ")");
          return null;
        });
        if (hostVerified(gmVerify)) {
          emit("implement-spec: fix-merge git state verified; treating as merged");
          fixMergerRun = gmVerify;
        } else {
          emit("ESCALATION: review fixes were produced but NOT merged into " +
               integrationBranch + " — the fixer's worktree may hold uncommitted work, and " +
               "the git-state verification did not confirm it is on the branch. " +
               "Gate label: " + String((gmVerify && gmVerify.error) || (fixMergerRun && fixMergerRun.error) || "unknown").slice(0, 500) + ". " +
               "Lead decision needed before any PR.");
        }
      }
    } else {
      emit("ESCALATION: review fix pass failed or was rejected — lead decision needed before any PR.");
    }
  }

  let postFixVerificationsPassed = true;
  if (fixRun && fixRun.ok && hostVerified(fixMergerRun)) {
    reviews = await runReviewPhase("post-fix", waveCount);
    reviewSummary = summarizeReviews(reviews);
    blockedAxes = reviewSummary.blockedAxes;
    unreviewedAxes = reviewSummary.unreviewedAxes;
    reviewsIncomplete = reviewSummary.reviewsIncomplete;
    if (reviewsIncomplete || blockedAxes.length > 0) {
      emit("ESCALATION: review remains incomplete or blocked after the single fix pass; PR suppressed");
    }
    if (!reviewsIncomplete && blockedAxes.length === 0) {
      for (const ref of merged) {
        const ticket = byRef[ref];
        if (!ticket) continue;
        let verifyRun = null;
        try {
          verifyRun = await spawnVerifier(ticket, "post-fix-" + waveCount);
        } catch (eVer) {
          emit("ticket " + ref + ": post-fix verifier launch rejected (" + eVer + ")");
        }
        const verdict = (verifyRun && verifyRun.ok) ? verificationVerdictOf(verifyRun) : "UNVERDICTED";
        ledgerFor(ref).verification = verdict;
        verifications.push({
          ref: ref,
          verdict: verdict,
          excerpt: String((verifyRun && verifyRun.output) || "").slice(0, 400)
        });
        if (verdict !== "OK") {
          postFixVerificationsPassed = false;
          escalate(ref, "post-fix independent verification did not pass (" + verdict + ")",
                   "the review fix changed the integration branch, but acceptance criteria did not verify");
          ledgerFor(ref).state = "escalated";
          escalated.push(ref);
        }
      }
    } else {
      postFixVerificationsPassed = false;
    }
  }

  runComplete = escalated.length === 0 && unresolved.length === 0;
  const reviewsReady = !reviewsIncomplete && (blockedAxes.length === 0 || !!(PR_WAIVER_REASON && !skipPR));
  const verificationReady = postFixVerificationsPassed;
  if (reviewsReady && verificationReady && runComplete) {
    const finalVerifyTask = [
      "The host runs the final full gate on the current HEAD of branch " + integrationBranch + ".",
      "Full gate: " + (FULL_GATE && FULL_GATE.command)
    ];
    finalVerifyTask.push.apply(finalVerifyTask, checkoutHint());
    finalVerifyTask.push(
      "The host gate checks the branch and runs the command after your response.",
      "Do not edit, stage, commit, or run the gate yourself. Report context only."
    );
    const finalVerifyTaskText = finalVerifyTask.join("\n");
    let verifyRun = null;
    try {
      verifyRun = await runs.run("final-verify", {
        label: "Final full-suite verification",
        agent: AG.worker,
        task: finalVerifyTaskText,
        timeoutMs: MERGE_TIMEOUT_MS,
        gate: hostGate("cd " + shellQuote(REPO_PATH) + " && test \"$(git branch --show-current)\" = " + shellQuote(integrationBranch) + " && (" + FULL_GATE.command + ")", GATE_TIMEOUT_MS),
        agentContract: { version: 1 },
        control: childControl(),
        // The host-run gate decides pass/fail; the child's prose is only
        // context. Do not let a missing acceptance report block a green gate
        // (JRB-016: three green merges rejected on report format).
        acceptance: false
      });
    } catch (eV) {
      emit("implement-spec: final-verify rejected (" + eV + ")");
    }
    finalVerifyPassed = hostVerified(verifyRun);
  }
  if (!finalVerifyPassed && reviewsReady && verificationReady && runComplete) {
    emit("implement-spec: final full-suite verification did not pass on the final reviewed commit; PR eligibility is blocked");
  }

  // Review fixes count as clean only after fresh reviews on the updated branch.
  const fixesClean = blockedAxes.length === 0 && !reviewsIncomplete;
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
      "Finish by calling structured_output:",
      "- prUrl: the request URL when a request was opened;",
      "- noPrSurface: true when this repo has no request surface (leave the work",
      "  on the integration branch).",
      "Report failure clearly if a request was expected but could not be opened."
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
    prSurfaceUnavailable = NO_PR_SURFACE && !!(prRun && prRun.ok && requestResult.noPrSurface && !prUrl);
    if (prRun && prRun.ok && prUrl && !requestResult.noPrSurface && PR_CHECK_COMMAND) {
      const confirmed = await runs.run("confirm-pr", {
        agent: AG.worker,
        label: "Check PR for " + integrationBranch,
        task: "Change nothing; the host gate verifies that the request exists.",
        quiet: true,
        gate: hostGate(checkedCommand(PR_CHECK_COMMAND, { PR_URL: prUrl, BRANCH: integrationBranch }), TRANSITION_TIMEOUT_MS),
        agentContract: { version: 1 }, acceptance: false
      });
      prCreated = hostVerified(confirmed);
    }
    if (!prCreated) prUrl = null;
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
    const reason = !runComplete
      ? "one or more in-scope issues are unresolved or escalated"
      : reviewsIncomplete
        ? "review incomplete"
        : blockedAxes.length && !prWaived
          ? "review blockers remain after the fix pass"
          : "final full-suite verification did not pass on the final commit";
    emit("implement-spec: PR suppressed — " + reason + "; lead decision needed");
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
  reviewBlockers: reviews ? reviews.filter(function(review) { return review.verdict === "BLOCK"; }) : [],
  verifications: verifications,
  fixApplied: !!(fixRun && fixRun.ok),
  fixMerged: hostVerified(fixMergerRun),
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
