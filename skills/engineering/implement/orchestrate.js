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
//   implTimeoutMs       default 45 min
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
  prWriter: ROLES.prWriter || "pr-writer"
};

const GATE_TIMEOUT_MS = numArg(A.gateTimeoutMs, 15 * 60 * 1000);
const IMPL_TIMEOUT_MS = numArg(A.implTimeoutMs, 45 * 60 * 1000);
const REVIEW_TIMEOUT_MS = numArg(A.reviewTimeoutMs, 20 * 60 * 1000);
const MAX_REMEDIATIONS = numArg(A.maxRemediations, 2);

// Config preflight — a malformed arg is a CONFIG error, not a task failure.
const configErrors = [];
requireInt(GATE_TIMEOUT_MS, "gateTimeoutMs", 1000, configErrors);
requireInt(IMPL_TIMEOUT_MS, "implTimeoutMs", 1000, configErrors);
requireInt(REVIEW_TIMEOUT_MS, "reviewTimeoutMs", 1000, configErrors);
requireInt(MAX_REMEDIATIONS, "maxRemediations", 0, configErrors);
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
  return {
    runId: runId,
    dir: asyncDir ? asyncDir + "/worktree-diffs/step-0/" : null,
    text: asyncDir
      ? asyncDir + "/worktree-diffs/step-0/  (the *.patch file in that directory)"
      : "run-directory/worktree-diffs/step-0/  (the *.patch file)"
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
    "2. Apply it to YOUR worktree: git apply --index <patch>",
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
    "2. Find and apply the captured patch: git apply --index <patch>",
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

function spawnReviews() {
  return runs.all([
    {
      key: "review-standards",
      label: "Review standards axis",
      agent: AG.reviewerStandards,
      task: reviewAxisTask("standards",
        "conformance to " + STANDARDS_DOCS + " and the repo's conventions",
        integrationBranch, BASE_BRANCH, REPO_PATH, ticketRef),
      timeoutMs: REVIEW_TIMEOUT_MS,
      control: childControl(REVIEW_TIMEOUT_MS)
    },
    {
      key: "review-quality",
      label: "Review quality axis",
      agent: AG.reviewerQuality,
      task: reviewAxisTask("quality",
        "correctness, robustness, test coverage, maintainability",
        integrationBranch, BASE_BRANCH, REPO_PATH, ticketRef),
      timeoutMs: REVIEW_TIMEOUT_MS,
      control: childControl(REVIEW_TIMEOUT_MS)
    }
  ]);
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

const blockedAxes = reviews.filter(function(r) { return r.verdict === "BLOCK"; });
const unreviewedAxes = reviews.filter(function(r) {
  return r.verdict !== "BLOCK" && r.verdict !== "OK";
});
const reviewsIncomplete = reviews.length < 2 || unreviewedAxes.length > 0;

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
      return {
        ok: false,
        error: "ESCALATION: review findings were fixed but NOT merged into " +
          integrationBranch + " — the fixer's worktree holds uncommitted work. " +
          "Lead decision needed before any PR.",
        escalated: true,
        ticket: ticketRef,
        failureClass: "merge"
      };
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
