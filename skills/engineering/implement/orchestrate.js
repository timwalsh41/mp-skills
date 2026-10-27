// ============================================================
// /implement orchestration workflow
// ============================================================
//
// Runs INSIDE the pi subagent workflow sandbox. That sandbox is a plain JS
// statement body with top-level await and NO fs/shell/require/tools — every
// action on the world goes through child agents via runs.run / runs.all.
//
// Contract with the invoking lead agent:
//   subagent({ workflow: "~/.pi/agent/skills/implement/orchestrate.js",
//              async: true, args: { ... } })
//
// Required args:
//   ticketRef           the ticket to implement (e.g. "JRB-008")
//   gate                this repo's verification command (from docs/agents/verification.md)
//   integrationBranch   the feature branch name (e.g. "jrb-008-epic-grooming-exemption")
//
// Optional args:
//   baseBranch          default "main"
//   repoPath            absolute path of the checkout (prevents wrong-dir false positives)
//   gateTimeoutMs       default 15 min
//   implTimeoutMs       default 75 min
//   reviewTimeoutMs     default 20 min
//   maxRemediations     default 2
//   skipPR              default false
//   prInstructions      how THIS repo opens a PR (overrides defaults)
//   standardsDocs       coding standards reference
//   trackerHint         short pointer to tracker read/update/resolve operations
//   singleRetestCommand how to run ONE narrow test (for the verifier)
//   agents              role-name map { implementer, reviewerStandards,
//                  reviewerQuality, verifier, merger, prWriter }
//
// Enforcement (do not bypass):
//   - The implementer runs in its OWN managed git worktree; parent checkout
//     is never switched; changes are committed via a merger child.
//   - Every child carries a verification gate that runs on the host.
//   - A review without a verdict line is INCOMPLETE, not a pass: PR suppressed.
//   - Independent verification of acceptance criteria required before PR.
//   - No PR unless reviews pass AND verification passes.

// ---------------------------------------------------------------------------
// Shared helpers — copied from implement-spec/orchestrate.js.
//
// These helpers (numArg, boolArg, gateObj, childControl, checkoutHint,
// reviewAxisTask, parseReviewVerdict, parseVerification, classifyFailure)
// are shared with the implement-spec workflow, but the Pi subagent workflow
// sandbox is a plain JS statement body with NO require/import/fs. We cannot
// import a shared module at runtime, so each orchestrate.js carries its own
// copy. If Pi ever adds module support to the workflow sandbox, these should
// be extracted into a single importable module to avoid drift.
// ---------------------------------------------------------------------------
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
function describeArg(value) {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}
function requireInt(value, name, min, errors) {
  if (!Number.isInteger(value)) {
    errors.push(name + " must be an integer (got " + describeArg(value) + ")");
  } else if (value < min) {
    errors.push(name + " must be >= " + min + " (got " + value + ")");
  }
}
function isConfigError(err) {
  return /must be an integer|must be a valid|is not supported|is invalid|requires a params|accepts one child|gate cannot be combined|unsupported/i.test(String(err || ""));
}
function keyOf(ref) { return String(ref).replace(/[^a-zA-Z0-9._-]+/g, "_"); }
function gateObj(command, timeoutMs) { return { command: command, timeoutMs: timeoutMs }; }
function childControl(gateTimeoutMs, silenceMarginMs) {
  silenceMarginMs = silenceMarginMs || (2 * 60 * 1000);
  return { needsAttentionAfterMs: gateTimeoutMs + silenceMarginMs, notifyOn: [] };
}
function checkoutHint(repoPath) {
  if (!repoPath) {
    return [
      "Before you conclude that anything is missing, confirm you are in the",
      "right checkout: run `git rev-parse --show-toplevel` and check it is the",
      "repository this run is integrating into. A child launched in the wrong",
      "directory sees no branch, no spec and no ticket — that is a wrong",
      "directory, not a missing target."
    ];
  }
  return [
    "The checkout to work in: " + repoPath,
    "Your working directory may not be that checkout. Start with:",
    "  git -C " + repoPath + " rev-parse --show-toplevel",
    "and work in " + repoPath + " (cd there) before you conclude that any",
    "branch, spec or file is missing — a child in the wrong directory sees",
    "none of them, and that is a wrong directory, not a missing target."
  ];
}
function reviewAxisTask(axis, focus, integrationBranch, baseBranch, repoPath, ticketRef) {
  const task = [
    "You are the " + axis + " reviewer.",
    "Review the diff " + baseBranch + "...HEAD on branch " + integrationBranch + ".",
    "Focus: " + focus,
    "Ticket: " + ticketRef,
    ""
  ];
  task.push.apply(task, checkoutHint(repoPath));
  task.push(
    "",
    "If the branch or ticket does not resolve, answer with one line:",
    "'Review verdict: MISSING_TARGET' plus what was absent, and stop. Do NOT",
    "review nearby or related work instead.",
    "",
    "Report concrete findings with file:line references. Otherwise end with",
    "exactly one line: 'Review verdict: BLOCK' (must-fix defects) or",
    "'Review verdict: OK' (none). A missing final line is treated as",
    "INCOMPLETE, not a pass."
  );
  return task.join("\n");
}
function parseReviewVerdict(output) {
  const text = String(output || "");
  if (text.indexOf("Review verdict: BLOCK") >= 0) return "BLOCK";
  if (text.indexOf("Review verdict: OK") >= 0) return "OK";
  if (text.indexOf("Review verdict: MISSING_TARGET") >= 0) return "MISSING_TARGET";
  return "UNVERDICTED";
}
function parseVerification(output) {
  const text = String(output || "");
  if (text.indexOf("Verification verdict: OK") >= 0) return "OK";
  if (text.indexOf("Verification verdict: UNMET") >= 0) return "UNMET";
  return "UNVERDICTED";
}
function classifyFailure(result, flakeRe) {
  if (!result) return "unknown";
  if (result.ok) return "ok";
  const err = String(result.error || "");
  if (isConfigError(err)) return "config";
  if (flakeRe && flakeRe.test(err)) return "flake";
  if (/timed?\s?out|timeout|deadline/i.test(err)) return "timeout";
  if (/gate/i.test(err)) return "gate";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const A = args || {};

const missingArgs = [];
if (!A.ticketRef) missingArgs.push("ticketRef");
if (!A.gate) missingArgs.push("gate");
if (!A.integrationBranch) missingArgs.push("integrationBranch");
if (missingArgs.length) {
  return {
    ok: false,
    error: "implement is missing required args: " + missingArgs.join(", ") +
      ". Resolve them from docs/agents/verification.md (gate, base branch) and " +
      "docs/agents/issue-tracker.md (ticket reference) and relaunch."
  };
}

const ticketRef = String(A.ticketRef);
const GATE = A.gate;
const integrationBranch = A.integrationBranch;
const baseRef = "refs/heads/" + integrationBranch;
const BASE_BRANCH = A.baseBranch || "main";
const REPO_PATH = A.repoPath || null;
// Optional tracker-agnostic transition command templates. Each value is a shell
// command string with $TICKET_REF, $BRANCH, and $PR_URL variables substituted.
// When omitted, no status transitions are performed (the ticket is still
// resolved by description per docs/agents/issue-tracker.md).
const TRANSITION_COMMANDS = A.transitionCommands || null;
function runTransition(phase, ref, variables) {
  if (!TRANSITION_COMMANDS || !TRANSITION_COMMANDS[phase]) {
    emit("implement: no transition command for '" + phase + "'; skipping");
    return Promise.resolve(null);
  }
  const substituted = TRANSITION_COMMANDS[phase]
    .replace(/\$TICKET_REF/g, String(ref))
    .replace(/\$BRANCH/g, String(variables.branch || ""))
    .replace(/\$PR_URL/g, String(variables.prUrl || ""));
  return runs.run("transition-" + phase + "-" + keyOf(ref), {
    agent: AG.worker,
    label: "Transition " + ref + " to " + phase,
    task: "Run this tracker transition command for ticket " + ref + ":\n" + substituted +
      "\nReport the HTTP status code or any error. Change nothing else in the repository.",
    timeoutMs: 60 * 1000,
    quiet: true
  }).then(function(r) {
    emit("implement: transition " + phase + " for " + ref + " -- " + (r && r.ok ? "done" : "failed"));
    return r;
  });
}
const STANDARDS_DOCS = A.standardsDocs ||
  "the files this repo documents as coding standards (search for CODING_STANDARDS.md, CONTRIBUTING.md, and anything AGENTS.md points at)";
const TRACKER_HINT = A.trackerHint || null;
const RETEST_COMMAND = A.singleRetestCommand || null;
const PR_INSTRUCTIONS = A.prInstructions || null;
const skipPR = boolArg(A.skipPR);
const STATUS_FIELD = "Status";
const ANSWER_HEADING = "## Answer";

const ROLES = A.agents || {};
const AG = {
  implementer: ROLES.implementer || "implementer",
  reviewerStandards: ROLES.reviewerStandards || "reviewer-standards",
  reviewerQuality: ROLES.reviewerQuality || "reviewer-quality",
  verifier: ROLES.verifier || "verifier",
  merger: ROLES.merger || "merger",
  prWriter: ROLES.prWriter || "pr-writer",
  // Lightweight git operator for setup tasks (branch creation, transitions).
  worker: ROLES.worker || "worker"
};
// Review axis configuration, used by spawnReviews and the UNVERDICTED retry logic.
const REVIEW_AXES = [
  { name: "standards", agent: AG.reviewerStandards, focus: "conformance to " + STANDARDS_DOCS + " and the repo's conventions" },
  { name: "quality", agent: AG.reviewerQuality, focus: "correctness, robustness, test coverage, maintainability" }
];

const GATE_TIMEOUT_MS = numArg(A.gateTimeoutMs, 15 * 60 * 1000);
const IMPL_TIMEOUT_MS = numArg(A.implTimeoutMs, 75 * 60 * 1000);
const REVIEW_TIMEOUT_MS = numArg(A.reviewTimeoutMs, 20 * 60 * 1000);
const MAX_REMEDIATIONS = numArg(A.maxRemediations, 2);
const MAX_REVIEW_RETRIES = numArg(A.maxReviewRetries, 2);

// Config preflight — a malformed arg is a CONFIG error, not a task failure.
const configErrors = [];
requireInt(GATE_TIMEOUT_MS, "gateTimeoutMs", 1000, configErrors);
requireInt(IMPL_TIMEOUT_MS, "implTimeoutMs", 1000, configErrors);
requireInt(REVIEW_TIMEOUT_MS, "reviewTimeoutMs", 1000, configErrors);
requireInt(MAX_REMEDIATIONS, "maxRemediations", 0, configErrors);
requireInt(MAX_REVIEW_RETRIES, "maxReviewRetries", 0, configErrors);
if (configErrors.length) {
  return {
    ok: false,
    error: "implement config error: " + configErrors.join("; ") +
      ". No child was launched. Fix the args and relaunch — a numeric arg must be a " +
      "number (a quoted number is a different number to the harness)."
  };
}

emit("implement: ticket=" + ticketRef + " integration=" + integrationBranch +
     " base=" + BASE_BRANCH + " gateTimeoutMs=" + GATE_TIMEOUT_MS +
     " implTimeoutMs=" + IMPL_TIMEOUT_MS +
     " maxRemediations=" + MAX_REMEDIATIONS +
     (skipPR ? " skipPR" : ""));

// ---------------------------------------------------------------------------
// Child spawners
// ---------------------------------------------------------------------------

// Locate the captured patch for a child run. The harness writes the
// implementer's uncommitted worktree changes to its run directory.
function patchLocation(result) {
  const runId = (result && result.runId) || "unknown";
  const paths = (result && Array.isArray(result.artifactPaths)) ? result.artifactPaths : [];
  const asyncDir = paths.find(function(p) {
    return typeof p === "string" && p.indexOf("async-subagent-runs") >= 0;
  }) || null;
  if (!asyncDir) {
    // Timeout/failure case: runId and artifactPaths may be missing from the
    // result (e.g. a timeout that threw before the harness captured them).
    // Point the fixer to a directory search instead of a dead "unknown/" path.
    return {
      runId: runId,
      dir: null,
      text: "run-directory/worktree-diffs/step-0/  (the *.patch file)" +
        "\n  If runId is 'unknown' (the child failed before the harness captured it):" +
        "\n    ls -dt ${TMPDIR:-/tmp}/pi-subagents-*/async-subagent-runs/*/worktree-diffs/step-0/*.patch | head -5" +
        "\n    identify the patch by its contents (it should touch the ticket's files)."
    };
  }
  return {
    runId: runId,
    dir: asyncDir + "/worktree-diffs/step-0/",
    text: asyncDir + "/worktree-diffs/step-0/  (the *.patch file in that directory)"
  };
}

function spawnImplementer() {
  const task = [
    "Implement EXACTLY ONE ticket using TDD (red-green-refactor).",
    "",
    "Ticket: " + ticketRef,
    ""
  ];
  if (TRACKER_HINT) {
    task.push("Tracker (this repo's convention — your worktree may not carry the tracker doc):", TRACKER_HINT, "");
  }
  task.push(
    "Rules:",
    "- Implement only this ticket: " + ticketRef,
    "- If the ticket description lacks a `**Status:**` line and `- [ ]` acceptance",
    "    criteria, groom it first (PATCH the description to add them, deriving",
    "    criteria from the ticket's approach/test_plan) before implementing.",
    "- Check off every acceptance criterion (`- [ ]`) as you satisfy it.",
    "- Set `**" + STATUS_FIELD + ":** resolved` when all criteria are checked.",
    "- Append a short implementation summary under '" + ANSWER_HEADING + "'.",
    "- Write/update tests for every criterion (unit/integration/E2E per the spec).",
    "- Your worktree branches from " + integrationBranch + "; do NOT create branches, worktrees, or spawn subagents.",
    "- Do NOT commit — leave your changes uncommitted; the orchestrator's merger captures and commits them.",
    "",
    "The verification gate runs on the host after you finish: " + GATE
  );
  return runs.run("impl-t" + keyOf(ticketRef), {
    label: "Implement " + ticketRef,
    agent: AG.implementer,
    task: task.join("\n"),
    worktree: true,
    baseRef: baseRef,
    timeoutMs: IMPL_TIMEOUT_MS,
    gate: gateObj(GATE, GATE_TIMEOUT_MS),
    control: childControl(GATE_TIMEOUT_MS)
  });
}

// A fixer that applies the previous run's captured patch and repairs it.
function spawnFixer(priorResult, wave) {
  const loc = patchLocation(priorResult);
  const task = [
    "REMEDIATION: the implementer for ticket " + ticketRef + " FAILED its gate.",
    "Its work is preserved as a captured patch; repair it, do not rewrite from scratch.",
    "",
    "Ticket: " + ticketRef,
    "Previous run id: " + loc.runId,
    "Where the captured patch is: " + loc.text,
    "  ls ${TMPDIR:-/tmp}/pi-subagents-*/async-subagent-runs/" + loc.runId + "/worktree-diffs/step-0/",
    "",
    "Steps:",
    "1. Find the previous run's captured patch (*.patch file in the directory above).",
    "2. Apply it to YOUR worktree: git apply --whitespace=fix --index <patch>",
    "   (your worktree already branches from " + integrationBranch + ").",
    "3. Run the gate: " + GATE,
    "4. Fix the failures, re-run the gate until green.",
    "5. Leave changes uncommitted — the orchestrator's merger captures and commits them.",
    "",
    "If the patch cannot be found or applied, report FAILURE clearly and change nothing."
  ];
  if (TRACKER_HINT) {
    task.push("", "Tracker: " + TRACKER_HINT);
  }
  return runs.run("fix-t" + keyOf(ticketRef) + "-w" + wave, {
    label: "Fix " + ticketRef + " after gate failure",
    agent: AG.implementer,
    task: task.join("\n"),
    worktree: true,
    baseRef: baseRef,
    timeoutMs: IMPL_TIMEOUT_MS,
    gate: gateObj(GATE, GATE_TIMEOUT_MS),
    control: childControl(GATE_TIMEOUT_MS)
  });
}

function spawnMerger(result, commitMsg, retry) {
  const loc = patchLocation(result);
  const label = "merge-" + (retry ? retry + "-" : "") + keyOf(ticketRef);
  const task = [
    "Merge the completed work for " + ticketRef + " into " + integrationBranch + ".",
    ""
  ];
  task.push.apply(task, checkoutHint(REPO_PATH));
  task.push(
    "",
    "Ticket: " + ticketRef,
    "",
    "The implementer/fixer worked in a managed worktree branching from " +
    integrationBranch + ". Its uncommitted changes were captured as a patch " +
    "in its run directory:",
    "  ls ${TMPDIR:-/tmp}/pi-subagents-*/async-subagent-runs/" + loc.runId + "/",
    "Patch location: " + loc.text,
    "",
    "Steps:",
    "1. Confirm the main checkout is on " + integrationBranch + " and clean (git status).",
    "   If dirty or on another branch, STOP and report.",
    "2. Find and apply the captured patch: git apply --whitespace=fix --index <patch>",
    "3. Commit: git commit -m \"" + commitMsg + "\"",
    "4. Re-run the gate yourself: " + GATE,
    "5. Return: merge status, commit hash, gate result.",
    "",
    "If the patch cannot be found or applied, report FAILURE clearly and change nothing."
  );
  return runs.run(label, {
    label: label,
    agent: AG.merger,
    task: task.join("\n"),
    timeoutMs: REVIEW_TIMEOUT_MS,
    gate: gateObj(GATE, GATE_TIMEOUT_MS),
    control: childControl(GATE_TIMEOUT_MS)
  });
}

// Retry a single UNVERDICTED review axis with a fresh key (bypasses cache reuse).
function respawnReview(axis, attempt) {
  const cfg = REVIEW_AXES.filter(function(a) { return a.name === axis; })[0];
  return runs.run("review-" + axis + "-retry-" + attempt, {
    label: "Review " + axis + " axis (retry " + attempt + ")",
    agent: cfg.agent,
    task: reviewAxisTask(axis, cfg.focus, integrationBranch, BASE_BRANCH, REPO_PATH, ticketRef),
    timeoutMs: REVIEW_TIMEOUT_MS,
    control: childControl(REVIEW_TIMEOUT_MS)
  });
}
function spawnReviews() {
  return runs.all(REVIEW_AXES.map(function(a) {
    return runs.run("review-" + a.name, {
      label: "Review " + a.name + " axis",
      agent: a.agent,
      task: reviewAxisTask(a.name, a.focus, integrationBranch, BASE_BRANCH, REPO_PATH, ticketRef),
      timeoutMs: REVIEW_TIMEOUT_MS,
      control: childControl(REVIEW_TIMEOUT_MS)
    });
  }));
}

function spawnVerifier() {
  const task = [
    "Independently verify ONE already-committed ticket against the code.",
    ""
  ];
  task.push.apply(task, checkoutHint(REPO_PATH));
  task.push(
    "",
    "The one ticket you own: " + ticketRef + ".",
    "Read it via the tracker convention in docs/agents/issue-tracker.md.",
    "",
    "What to verify against: branch " + integrationBranch + " in that checkout,",
    "the ticket above.",
    "Targeted test command form: " + (RETEST_COMMAND
      ? RETEST_COMMAND + " — substitute the test that covers the criterion."
      : "read docs/agents/verification.md for how this repo runs one narrow slice of tests."),
    ""
  );
  if (TRACKER_HINT) {
    task.push("Tracker (this repo's convention — your worktree may not carry the tracker doc):", TRACKER_HINT, "");
  }
  task.push(
    "Do not take the implementer's acceptance checkboxes as evidence — re-derive",
    "each criterion from the committed code. For EACH criterion, gather first-hand",
    "evidence: inspect the code and, where meaningful, run the targeted test.",
    "Report each as satisfied/not with evidence (file:line, test name, command, result).",
    "",
    "Record your findings under '" + ANSWER_HEADING + "' in the ticket. Do NOT toggle",
    "acceptance checkboxes or change the ticket's status. Do NOT edit code, commit,",
    "or spawn subagents.",
    "",
    "The LAST line of your final response MUST be exactly:",
    "  Verification verdict: OK    — every criterion is satisfied, with evidence",
    "  Verification verdict: UNMET  — at least one criterion is not satisfied"
  );
  return runs.run("verify", {
    label: "Verify " + ticketRef + " against committed code",
    agent: AG.verifier,
    task: task.join("\n"),
    timeoutMs: REVIEW_TIMEOUT_MS,
    control: childControl(REVIEW_TIMEOUT_MS)
  });
}

function spawnPrWriter() {
  const task = [
    PR_INSTRUCTIONS
      ? PR_INSTRUCTIONS
      : "Open this repo's pull request for " + integrationBranch +
        ", using the command recorded in docs/agents/verification.md.",
    ""
  ];
  task.push.apply(task, checkoutHint(REPO_PATH));
  task.push(
    "",
    "Branch: " + integrationBranch + " -> " + BASE_BRANCH + ", covering " + ticketRef + ".",
    "The ticket at " + ticketRef + " holds the acceptance answer.",
    "Push the head branch first (git push -u origin " + integrationBranch + ")",
    "if it is not on the remote."
  );
  return runs.run("pr", {
    label: "Open pull request for " + ticketRef,
    agent: AG.prWriter,
    task: task.join("\n"),
    timeoutMs: REVIEW_TIMEOUT_MS,
    control: childControl(REVIEW_TIMEOUT_MS)
  });
}

// ---------------------------------------------------------------------------
// Main flow — top-level await only.
// ---------------------------------------------------------------------------

let implResult = null;
let remediationAttempt = 0;

// Phase 0: ensure the integration branch exists, then transition to In Progress.
if (REPO_PATH) {
  const ensureBranch = await runs.run("ensure-integration-branch", {
    agent: AG.worker,
    label: "Create integration branch " + integrationBranch + " from " + BASE_BRANCH,
    task: "Ensure the git branch '" + integrationBranch + "' exists in " + REPO_PATH +
      ", creating it from '" + BASE_BRANCH + "' if missing.\n" +
      "1. git -C " + REPO_PATH + " rev-parse --verify refs/heads/" + integrationBranch +
      " -> if it succeeds, report BRANCH_EXISTS and exit.\n" +
      "2. If it does not: git -C " + REPO_PATH + " branch " + integrationBranch + " " + BASE_BRANCH +
      " && git -C " + REPO_PATH + " push -u origin " + integrationBranch +
      " 2>/dev/null || true. Report BRANCH_CREATED.\n" +
      "3. Change nothing else. Do not switch branches or modify files.",
    timeoutMs: 30 * 1000,
    quiet: true
  });
  if (!ensureBranch || !ensureBranch.ok || !String(ensureBranch.output || "").match(/BRANCH_EXISTS|BRANCH_CREATED/)) {
    emit("implement: WARNING - could not ensure integration branch '" + integrationBranch + "'; worktree children may fail");
  } else {
    emit("implement: integration branch '" + integrationBranch + "' ensured");
  }
}

// Phase 0.5: validate the ticket is groomed (has **Status:** and - [ ]).
if (REPO_PATH && TRACKER_HINT) {
  const groomCheck = await runs.run("groom-check-" + keyOf(ticketRef), {
    agent: AG.worker,
    label: "Validate ticket " + ticketRef + " is groomed",
    task: "Read ticket " + ticketRef + " from " + TRACKER_HINT + ".\n" +
      "Check if its description has a `**Status:**` line and at least one `- [ ]` acceptance criterion.\n" +
      "Report GROOMED_OK if both are present, or GROOM_NEEDED if either is missing.\n" +
      "Do NOT modify the ticket or any files.",
    timeoutMs: 60 * 1000,
    quiet: true
  });
  if (groomCheck && groomCheck.ok && String(groomCheck.output || "").indexOf("GROOM_NEEDED") >= 0) {
    emit("implement: WARNING - ticket " + ticketRef + " is NOT groomed " +
         "(missing **Status:** or - [ ]). Groom it before relaunching.");
  } else if (groomCheck && groomCheck.ok) {
    emit("implement: ticket " + ticketRef + " is groomed");
  }
}
await runTransition("in_progress", ticketRef, { branch: integrationBranch });

// Phase 1: implement the ticket (worktree-isolated, gated).
try {
  implResult = await spawnImplementer();
} catch (e) {
  if (isConfigError(e)) {
    return {
      ok: false,
      error: "implement config error while launching implementer: " + String(e) +
        ". No child was launched. Fix the args and relaunch.",
      configError: true
    };
  }
  implResult = { ok: false, error: String(e) };
}

// Remediation: if the implementer or its gate failed, retry via a fixer.
while (!implResult || !implResult.ok) {
  if (isConfigError(implResult && implResult.error)) {
    return {
      ok: false,
      error: "implement config error: " + implResult.error +
        ". No ticket is at fault. Fix the args and relaunch.",
      configError: true
    };
  }
  const cls = classifyFailure(implResult);
  if (remediationAttempt >= MAX_REMEDIATIONS) {
    return {
      ok: false,
      error: "ESCALATION: implementer for " + ticketRef + " failed after " +
        MAX_REMEDIATIONS + " remediation attempts (" + cls + "). Last error: " +
        (implResult && implResult.error || "unknown") +
        " | Lead decision needed.",
      escalated: true,
      ticket: ticketRef,
      failureClass: cls,
      runId: implResult && implResult.runId
    };
  }
  remediationAttempt = remediationAttempt + 1;
  emit("implement: " + ticketRef + " " + cls + " failure — remediation attempt " +
       + remediationAttempt + "/" + MAX_REMEDIATIONS);
  try {
    implResult = await spawnFixer(implResult, remediationAttempt);
  } catch (e) {
    if (isConfigError(e)) {
      return {
        ok: false,
        error: "implement config error while launching fixer: " + String(e),
        configError: true
      };
    }
    implResult = { ok: false, error: String(e) };
  }
}

// Phase 1.5: capture the implementer's uncommitted work and commit it
// onto the integration branch via a merger child.
let mergeResult = null;
try {
  mergeResult = await spawnMerger(implResult, "Implement ticket " + ticketRef);
} catch (e) {
  if (isConfigError(e)) {
    return {
      ok: false,
      error: "implement config error while launching merger: " + String(e),
      configError: true
    };
  }
  emit("implement: merger for " + ticketRef + " rejected (" + e + ")");
}
if (!mergeResult || !mergeResult.ok) {
  // One idempotent retry — a transient lock or race on the checkout.
  try {
    mergeResult = await spawnMerger(implResult, "Implement ticket " + ticketRef, 2);
  } catch (e2) {
    emit("implement: merger retry rejected (" + e2 + ")");
  }
}
if (!mergeResult || !mergeResult.ok) {
  return {
    ok: false,
    error: "ESCALATION: " + ticketRef + " was implemented but the merger FAILED to commit its work. " +
      "The implementer's retained worktree still holds uncommitted changes. " +
      "Lead decision needed before any PR.",
    escalated: true,
    ticket: ticketRef,
    failureClass: "merge",
    runId: implResult && implResult.runId
  };
}

// Phase 2: two-axis review (standards + quality), in parallel.
let reviewResults = null;
try {
  reviewResults = await spawnReviews();
} catch (e) {
  emit("implement: review fan-out rejected (" + e + "); proceeding without reviews");
  reviewResults = [];
}
const reviews = reviewResults.map(function(r, i) {
  const axes = ["standards", "quality"];
  const out = (r && r.output) ? String(r.output) : "";
  let verdict;
  if (!r || !r.ok) verdict = "UNVERDICTED";
  else verdict = parseReviewVerdict(out);
  return {
    axis: axes[i] || ("axis" + i),
    ok: !!(r && r.ok),
    verdict: verdict,
    excerpt: out.slice(0, 400)
  };
});

let blockedAxes = reviews.filter(function(r) { return r.verdict === "BLOCK"; });
let unreviewedAxes = reviews.filter(function(r) {
  return r.verdict !== "BLOCK" && r.verdict !== "OK";
});
let reviewsIncomplete = reviews.length < 2 || unreviewedAxes.length > 0;

// Retry UNVERDICTED review axes (transient failures like model-provider
// Cloudflare blocks). Process results individually — a partial runs.all
// result preserves surviving verdicts instead of discarding all of them.
let reviewRetryAttempt = 0;
while (reviewsIncomplete && reviewRetryAttempt < MAX_REVIEW_RETRIES) {
  reviewRetryAttempt = reviewRetryAttempt + 1;
  const retryAxes = reviews.filter(function(r) { return r.verdict === "UNVERDICTED"; });
  if (!retryAxes.length) break;
  emit("implement: retrying UNVERDICTED review axes: " +
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
    if (res && res.ok) verdict = parseReviewVerdict(out);
    const idx = reviews.findIndex(function(x) { return x.axis === r.axis; });
    reviews[idx] = { axis: r.axis, ok: !!(res && res.ok), verdict: verdict, excerpt: out.slice(0, 400) };
  });
  blockedAxes = reviews.filter(function(r) { return r.verdict === "BLOCK"; });
  unreviewedAxes = reviews.filter(function(r) {
    return r.verdict !== "BLOCK" && r.verdict !== "OK";
  });
  reviewsIncomplete = reviews.length < 2 || unreviewedAxes.length > 0;
}

let fixApplied = false;
let fixMerged = false;

if (blockedAxes.length) {
  // Fix pass: worktree-isolated, repairs review findings.
  const fixBrief = [
    "Reviewers BLOCKED the work on " + integrationBranch + ".",
    "Findings (excerpts):",
    JSON.stringify(blockedAxes, null, 2),
    "",
    "Fix must-fix defects in YOUR managed worktree (already branched from",
    integrationBranch + "), keep the gate green: " + GATE,
    "",
    "Leave changes uncommitted — the orchestrator's merger captures and commits them.",
    "Do NOT spawn subagents. End with the acceptance-report block."
  ].join("\n");
  let fixResult = null;
  try {
    fixResult = await runs.run("fix-review-findings", {
      label: "Fix review findings for " + ticketRef,
      agent: AG.implementer,
      task: fixBrief,
      worktree: true,
      baseRef: baseRef,
      timeoutMs: IMPL_TIMEOUT_MS,
      gate: gateObj(GATE, GATE_TIMEOUT_MS),
      control: childControl(GATE_TIMEOUT_MS)
    });
  } catch (eFx) {
    emit("implement: fix-review-findings rejected (" + eFx + ")");
  }

  if (fixResult && fixResult.ok) {
    fixApplied = true;
    let fixMergerResult = null;
    try {
      fixMergerResult = await spawnMerger(fixResult, "Address review findings", "fix");
    } catch (eM) {
      emit("implement: merge-review-fixes rejected (" + eM + ")");
    }
    fixMerged = !!(fixMergerResult && fixMergerResult.ok);
    if (!fixMerged) {
      // Acceptance-format rejection may not mean the work is absent. Verify
      // git state directly: if the fixer's changes are present on the branch
      // and the gate passes, treat the merge as successful.
      const gmVerify = await runs.run("verify-fix-merge-" + keyOf(ticketRef), {
        agent: AG.merger,
        label: "Verify fix-merge git state for " + ticketRef,
        task: "The merge-review-fixes child reported failure, but its work may already be committed. " +
          "Confirm: (1) checkout is on " + integrationBranch + " and clean; " +
          "(2) the fixer's changes are present (git log --oneline main.." + integrationBranch +
          " shows commits beyond the original implementation); (3) the gate " + GATE +
          " passes. If (3) passes and (2) shows changes, report MERGE_EFFECTIVE. " +
          "If the changes are NOT present, report MERGE_MISSING. " + checkoutHint(REPO_PATH),
        timeoutMs: GATE_TIMEOUT_MS,
        quiet: true
      }).catch(function(e) {
        emit("implement: fix-merge verification rejected (" + e + ")");
        return null;
      });
      const gmOutput = (gmVerify && gmVerify.output) ? String(gmVerify.output) : "";
      if (gmVerify && gmVerify.ok && gmOutput.indexOf("MERGE_EFFECTIVE") >= 0) {
        emit("implement: fix-merge acceptance rejected but git state verified; treating as merged");
        fixMerged = true;
      } else {
        return {
          ok: false,
          error: "ESCALATION: review findings were fixed but NOT merged into " +
            integrationBranch + " — the fixer's worktree holds uncommitted work, and " +
            "the git-state verification did not confirm it is on the branch. " +
            "Lead decision needed before any PR.",
          escalated: true,
          ticket: ticketRef,
          failureClass: "merge"
        };
      }
    }
  } else {
    return {
      ok: false,
      error: "ESCALATION: review fix pass failed — lead decision needed before any PR.",
      escalated: true,
      ticket: ticketRef,
      failureClass: "review-fix"
    };
  }
}

// Phase 3: independent verification of the ticket's acceptance criteria.
let verifyResult = null;
try {
  verifyResult = await spawnVerifier();
} catch (eVer) {
  emit("implement: verifier launch rejected (" + eVer + ")");
}
const verificationVerdict = (verifyResult && verifyResult.ok)
  ? parseVerification(verifyResult.output)
  : "UNVERDICTED";

if (verificationVerdict !== "OK") {
  return {
    ok: false,
    error: "ESCALATION: independent verification of " + ticketRef +
      " did not pass (" + verificationVerdict + "). The work is committed to " +
      integrationBranch + " but its acceptance criteria are unverified. " +
      "Lead decision needed: targeted fix, or accept the gap explicitly.",
    escalated: true,
    ticket: ticketRef,
    verification: verificationVerdict
  };
}

// Phase 4: open the PR only when the tree is in a known-good state.
const reviewsOk = !reviewsIncomplete && blockedAxes.length === 0;
if (!reviewsOk) {
  return {
    ok: false,
    error: "ESCALATION: review is incomplete or blocked for " + ticketRef +
      " — PR suppressed. " +
      (reviewsIncomplete ? "An axis returned no 'Review verdict:' line (treated as INCOMPLETE, not a pass)." : ""),
    escalated: true,
    ticket: ticketRef,
    reviews: reviews,
    reviewsIncomplete: reviewsIncomplete
  };
}

let prResult = null;
if (!skipPR) {
  try {
    prResult = await spawnPrWriter();
  } catch (eP) {
    emit("implement: pr-writer rejected (" + eP + ")");
  }
  // Transition ticket to Ready for Review and Complete (tracker-agnostic hook).
  if (prResult && prResult.ok) {
    const prUrl = String(prResult.output || "").match(/https?:\/\/[^\s]+pull\/\d+/) || "";
    await runTransition("ready_for_review", ticketRef, { branch: integrationBranch, prUrl: prUrl });
    await runTransition("complete", ticketRef, { branch: integrationBranch, prUrl: prUrl });
  }
}

// Cleanup: remove child worktrees that persist after completion.
if (REPO_PATH) {
  await runs.run("cleanup-worktrees-" + keyOf(ticketRef), {
    agent: AG.worker,
    label: "Clean up child worktrees for " + ticketRef,
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
  }).catch(function(e) { emit("implement: worktree cleanup error: " + e); });
}

emit("implement: " + ticketRef + " complete — merged on " + integrationBranch +
     ", reviews OK, verified, " + (skipPR ? "SKIP PR" : (prResult && prResult.ok ? "PR created" : "PR FAILED")));

return {
  ok: true,
  ticket: ticketRef,
  integrationBranch: integrationBranch,
  baseBranch: BASE_BRANCH,
  gate: GATE,
  remediationAttempts: remediationAttempt,
  reviews: reviews,
  verification: verificationVerdict,
  fixApplied: fixApplied,
  fixMerged: fixMerged,
  prCreated: !!(prResult && prResult.ok),
  prOutput: prResult && prResult.output ? prResult.output.slice(0, 400) : null,
  runIds: {
    implementer: implResult && implResult.runId,
    verifier: verifyResult && verifyResult.runId
  }
};
