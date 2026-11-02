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
//   fullGate            full verification command; legacy alias: gate
//   integrationBranch   the feature branch name (e.g. "jrb-008-epic-grooming-exemption")
//
// Optional args:
//   narrowGate          fast host-run gate for intermediate work (default: fullGate)
//   baseBranch          default "main"
//   repoPath            REQUIRED absolute checkout path (host checks run there)
//   finalizeMergedPR    run the merge-confirmation and Complete-transition phase only
//   prUrl / mergeRef    evidence locator required by finalizeMergedPR
//   prWaiverReason      explicit user waiver of completed review blockers only
//   transitionCommands optional tracker-command overrides; default is issue-tracker docs
//   transitionCheckCommands host commands per lifecycle phase; exit 0 only
//                      when the issue is in the requested status. $TICKET_REF
//                      and $PHASE are replaced with shell-quoted values.
//   prCheckCommand     host command verifying $PR_URL exists for $BRANCH
//                      (required when opening a PR)
//   mergeCheckCommand  host command verifying $MERGE_REF contains $TICKET_REF
//                      (required for finalizeMergedPR)
//   noPrSurface        true only if repo docs explicitly rule out PRs
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
//   - A review without a structured verdict is INCOMPLETE, not a pass: PR suppressed.
//   - Children whose judgment decides an outcome (reviews, verification, PR,
//     transitions, merge confirmation, grooming) report through the harness's
//     structured_output tool. The orchestrator reads parsed fields; it never
//     scans child prose for decision tokens (JRB-016/JRB-017: prose token
//     parsing rejected green children and misread compliance statements).
//   - Children whose success is decided by a host-run gate or by git state
//     (mergers, final gate, verify-fix) carry acceptance: false, so a missing
//     acceptance report can never reject a green result.
//   - Independent verification of acceptance criteria required before PR.
//   - No PR unless reviews and verification pass, except an explicit review waiver
//     that opens a draft and returns a non-green result.
//   - Lifecycle transitions follow docs/agents/issue-tracker.md by default; Complete
//     is only available through the merge-confirmation phase.

// ---------------------------------------------------------------------------
// Shared helpers — copied from implement-spec/orchestrate.js.
//
// These helpers (numArg, boolArg, gateObj, childControl, checkoutHint,
// reviewAxisTask, classifyFailure)
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
function gateObj(command, timeoutMs) { return { command: command, timeoutMs: timeoutMs }; }
// Host-owned typed evidence does not require the worker to fabricate an
// acceptance report. Always check this field, not only the child's exit code.
function hostGate(command, timeoutMs) {
  return {
    command: "(" + command + ") 1>&2 && printf '{\"verified\":true}\\n'",
    output: "json",
    schema: { type: "object", properties: { verified: { type: "boolean", const: true } }, required: ["verified"], additionalProperties: false },
    timeoutMs: timeoutMs
  };
}
function hostVerified(result) {
  return !!(result && result.ok && result.structuredOutput && result.structuredOutput.verified === true);
}
// Gate args: be liberal — a bare command string or a { command, timeoutMs }
// object are both accepted. Booleans, numbers and other junk are rejected
// here with an exact, named message (JRB-016: two launches were burned passing
// objects and booleans where a string was expected, each surfacing only at
// implementer spawn a minute into the run).
function unwrapGate(value, label, errors) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim()) {
    return { command: value.trim(), timeoutMs: null };
  }
  if (value && typeof value === "object" && !Array.isArray(value) &&
      typeof value.command === "string" && value.command.trim()) {
    return {
      command: value.command.trim(),
      timeoutMs: typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
        ? value.timeoutMs : null
    };
  }
  errors.push(label + " must be a command string or { command, timeoutMs }; got: " + describeArg(value));
  return null;
}
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
    "If the branch or ticket does not resolve, answer with verdict MISSING_TARGET",
    "(name what was absent in missingTarget) and stop. Do NOT review nearby or",
    "related work instead.",
    "Trace changed shared files to their other callers and rendering modes; verify",
    "adjacent workflows support the change end to end or hide unsupported input.",
    "",
    "Report concrete findings with file:line references, then call structured_output:",
    "- verdict: OK (no must-fix defects), BLOCK (must-fix defects exist), or",
    "  MISSING_TARGET (the target named above does not resolve).",
    "- findings: a summary of your concrete findings (empty or omitted when none).",
    "A missing or malformed structured verdict is an incomplete review, not a pass."
  );
  return task.join("\n");
}
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
// schema-free.
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
const GROOM_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    groomed: { type: "boolean" },
    missing: { type: "string" }
  },
  required: ["groomed"],
  additionalProperties: false
};
const REVIEW_VERDICTS = ["OK", "BLOCK", "MISSING_TARGET"];
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const A = args || {};

const finalizeMergedPR = boolArg(A.finalizeMergedPR);
// Config preflight errors collect here; unwrapGate (below) reports gate-arg
// violations into this array, so it must be declared before the gate args.
// Gates are normalized ONCE here: a string or { command, timeoutMs } object
// both yield a { command, timeoutMs } gate, and every later consumer can rely
// on .command (JRB-016: two launches were burned on raw strings reaching
// gateObj(FULL_GATE.command), which produced { command: undefined }).
const configErrors = [];
const FULL_GATE = unwrapGate(A.fullGate || A.gate, "fullGate", configErrors);
const NARROW_GATE = unwrapGate(A.narrowGate, "narrowGate", configErrors) || FULL_GATE;
const missingArgs = [];
if (!A.ticketRef) missingArgs.push("ticketRef");
if (!finalizeMergedPR && !FULL_GATE) missingArgs.push("fullGate");
if (!A.repoPath) missingArgs.push("repoPath");
if (!A.integrationBranch) missingArgs.push("integrationBranch");
if (finalizeMergedPR && !(A.prUrl || A.mergeRef)) missingArgs.push("prUrl or mergeRef for post-merge confirmation");
if (missingArgs.length) {
  return {
    ok: false,
    error: "implement is missing required args: " + missingArgs.join(", ") +
      ". Resolve them from docs/agents/verification.md (gate, base branch) and " +
      "docs/agents/issue-tracker.md (ticket reference and lifecycle workflow) and relaunch."
  };
}

const ticketRef = String(A.ticketRef);
const integrationBranch = A.integrationBranch;
const baseRef = "refs/heads/" + integrationBranch;
const BASE_BRANCH = A.baseBranch || "main";
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
    ? "Run this tracker transition command for ticket " + ref + ":\n" +
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
      "\nBefore applying any transition, verify the current status matches the" +
      " expected phase for this step; do not pick a different transition just" +
      " because it is allowed. If the current status is neither the expected" +
      " source nor the target, report TRANSITION_STATE_MISMATCH and change" +
      " nothing." +
      "\nReport the HTTP status code or error. Change nothing else.",
    timeoutMs: TRANSITION_TIMEOUT_MS,
    quiet: true,
    outputSchema: TRANSITION_OUTPUT_SCHEMA,
    // Transitions are lifecycle writes, not deliverables: no acceptance
    // report, and the outcome is read from the structured result, never
    // scanned from prose (JRB-016: a prose confession regex aborted a green
    // run on a compliance statement).
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
    emit("implement: transition " + phase + " for " + ref + " -- " + (unsupported ? "unsupported by tracker" : (ok ? "done" : "failed (" + (outcome || "no structured outcome") + ")")));
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
function confirmMerged(ref, mergeRef) {
  return runs.run("confirm-merge-" + keyOf(ref), {
    agent: AG.worker,
    label: "Confirm merge for " + ref,
    task: [
      "Read docs/agents/issue-tracker.md and docs/agents/verification.md in " + (REPO_PATH || "the target repository") + ".",
      "Confirm using the documented merge/request process that this issue's work has reached its completion point.",
      "Issue: " + ref,
      "Integration branch: " + integrationBranch,
      "Merge or PR reference: " + mergeRef,
      "Do not change issue status. Report the outcome through structured_output:",
      "confirmed: true when the documented process confirms the work reached its", 
      "completion point, false otherwise, plus the evidence you relied on."
    ].join("\n"),
    timeoutMs: TRANSITION_TIMEOUT_MS,
    quiet: true,
    outputSchema: CONFIRM_MERGE_OUTPUT_SCHEMA,
    acceptance: false
  }).then(function(reported) {
    if (!reported || !reported.ok || !reported.structuredOutput || reported.structuredOutput.confirmed !== true) return reported;
    return runs.run("check-merge-" + keyOf(ref), {
      agent: AG.worker,
      label: "Check merge for " + ref,
      task: "Change nothing; the host gate verifies the merge reference.",
      quiet: true,
      gate: hostGate(checkedCommand(MERGE_CHECK_COMMAND, { MERGE_REF: mergeRef, TICKET_REF: ref, BRANCH: integrationBranch }), TRANSITION_TIMEOUT_MS),
      agentContract: { version: 1 }, acceptance: false
    }).then(function(check) {
      return { ok: hostVerified(check), structuredOutput: reported.structuredOutput, output: reported.output };
    });
  });
}
const STANDARDS_DOCS = A.standardsDocs ||
  "the files this repo documents as coding standards (search for CODING_STANDARDS.md, CONTRIBUTING.md, and anything AGENTS.md points at)";
const TRACKER_HINT = A.trackerHint || null;
const RETEST_COMMAND = A.singleRetestCommand || null;
const PR_INSTRUCTIONS = A.prInstructions || null;
const PR_WAIVER_REASON = typeof A.prWaiverReason === "string" ? A.prWaiverReason.trim() : "";
const skipPR = boolArg(A.skipPR);

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
// Transitions, merge confirmation, and grooming checks are short, scripted
// lifecycle steps, but their default tasks read the tracker docs before
// acting, and 60s proved too tight whenever a child did anything beyond two
// HTTP calls (JRB-014: a transition child spent its budget and aborted the
// whole run). Hardcoded on purpose: a lifecycle step should never need
// per-repo tuning.
const TRANSITION_TIMEOUT_MS = 3 * 60 * 1000;

requireInt(GATE_TIMEOUT_MS, "gateTimeoutMs", 1000, configErrors);
requireInt(IMPL_TIMEOUT_MS, "implTimeoutMs", 1000, configErrors);
requireInt(REVIEW_TIMEOUT_MS, "reviewTimeoutMs", 1000, configErrors);
requireInt(MAX_REMEDIATIONS, "maxRemediations", 0, configErrors);
requireInt(MAX_REVIEW_RETRIES, "maxReviewRetries", 0, configErrors);
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
    error: "implement config error: " + configErrors.join("; ") +
      ". No child was launched. Fix the args and relaunch.",
    configError: true
  };
}

emit("implement: ticket=" + ticketRef + " integration=" + integrationBranch +
     " base=" + BASE_BRANCH + " gateTimeoutMs=" + GATE_TIMEOUT_MS +
     " implTimeoutMs=" + IMPL_TIMEOUT_MS +
     " gates=[full: " + (FULL_GATE && FULL_GATE.command) + "]" +
     (FULL_GATE && NARROW_GATE && NARROW_GATE.command !== FULL_GATE.command
       ? " [narrow: " + NARROW_GATE.command + "]" : "") +
     " maxRemediations=" + MAX_REMEDIATIONS +
     (skipPR ? " skipPR" : ""));

if (finalizeMergedPR) {
  const mergeRef = String(A.prUrl || A.mergeRef);
  const confirmation = await confirmMerged(ticketRef, mergeRef);
  const mergeConfirmed = !!(confirmation && confirmation.ok &&
    confirmation.structuredOutput && confirmation.structuredOutput.confirmed === true);
  if (!mergeConfirmed) {
    return {
      ok: false,
      ticket: ticketRef,
      finalized: false,
      error: "The issue tracker did not confirm that the merge is complete. No Complete transition was attempted.",
      mergeEvidence: String((confirmation && confirmation.output) || "")
    };
  }
  const completion = await runTransition("complete", ticketRef, { branch: integrationBranch, prUrl: A.prUrl || A.mergeRef });
  return {
    ok: !!(completion && completion.ok),
    ticket: ticketRef,
    finalized: !!(completion && completion.ok),
    statusTransitionUnsupported: !!(completion && completion.unsupported),
    transition: completion,
    error: completion && completion.ok ? null : "Merge was confirmed, but the issue could not be transitioned to Complete."
  };
}

// ---------------------------------------------------------------------------
// Child spawners
// ---------------------------------------------------------------------------

// Locate the captured patch for a child run. The harness writes the
// implementer's uncommitted worktree changes to its run directory.
function patchLocation(result) {
  const runId = (result && result.runId) || "unknown";
  const paths = (result && Array.isArray(result.artifactPaths)) ? result.artifactPaths : [];
  const asyncDir = (result && result.asyncDir) || paths.find(function(p) {
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
    "Read docs/agents/issue-tracker.md first. It is the source of truth for ticket fields, acceptance evidence, and lifecycle status.",
    "Rules:",
    "- Implement only this ticket: " + ticketRef,
    "- The orchestrator confirmed this ticket is groomed. If it is not ready, stop and report that grooming is required instead of implementing or changing lifecycle status.",
    "- Record your implementation report under `## Agent Execution Evidence` / `### Implementation` in the ticket description, following docs/agents/issue-tracker.md.",
    "  Reconcile, never append: fetch the current description first; if a `### Implementation`",
    "  section already exists, replace/merge it in place — one section, latest content, with a",
    "  timestamp. Never duplicate section headers.",
    "- Do not change lifecycle status; the orchestrator owns In Progress and Ready for Review transitions, and Complete is post-merge only.",
    "- Write/update tests for every criterion (unit/integration/E2E per the spec); trace shared files to other callers and protect adjacent workflows.",
    "- Your worktree branches from " + integrationBranch + "; do NOT create branches, worktrees, or spawn subagents.",
    "- Do NOT commit — leave your changes uncommitted; the orchestrator's merger captures and commits them.",
    "- If the repo configures a pre-commit formatter (check .pre-commit-config.yaml and the format command in docs/agents/verification.md or CODING_STANDARDS.md), run it over the files you changed before finishing, then re-run the gate. The merger's commit-time pre-commit hook reformats anything left unformatted, and the captured patch must already be in the form that lands (JRB-018).",
    "",
    "The intermediate verification gate runs on the host after you finish: " + (NARROW_GATE && NARROW_GATE.command)
  );
  return runs.run("impl-t" + keyOf(ticketRef), {
    label: "Implement " + ticketRef,
    agent: AG.implementer,
    task: task.join("\n"),
    worktree: true,
    baseRef: baseRef,
    timeoutMs: IMPL_TIMEOUT_MS,
    gate: gateObj(NARROW_GATE.command, GATE_TIMEOUT_MS),
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
    "3. Fix the failures the orchestrator reported; the intermediate gate runs on the host automatically once you finish, so leave your changes uncommitted for it to capture.",
    "4. Run the repo's configured pre-commit formatter (see .pre-commit-config.yaml; the command is documented in docs/agents/verification.md or CODING_STANDARDS.md) over the files you changed before finishing, then re-check the gate: the merger's commit-time hook reformats anything left unformatted (JRB-018).",
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
    gate: gateObj(NARROW_GATE.command, GATE_TIMEOUT_MS),
    control: childControl(GATE_TIMEOUT_MS)
  });
}

// Merger gate body, shared with implement-spec/orchestrate.js (duplicated
// because the workflow sandbox cannot import modules). Proves on the host:
// right branch, clean tree, the captured patch's content is on the branch,
// issue trailers exist, and the suite is green. Every clause labels its own
// failure on stderr, so an escalation names the exact failed check instead of
// a bare exit code (JRB-018: a five-clause && chain produced one opaque
// failure and forced manual forensics).
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
function mergeGate(result) {
  const loc = patchLocation(result);
  const prologue = loc.dir
    ? [
        "set -- " + shellQuote(loc.dir) + "/*.patch",
        "test \"$#\" -eq 1 && test -f \"$1\" || fail \"expected exactly one captured patch in " + loc.dir + ", found $#\"",
        "pfile=$1"
      ].join("\n")
    : null;
  return hostGate(mergerGateBody(prologue, [ticketRef], NARROW_GATE.command), GATE_TIMEOUT_MS);
}
function spawnMerger(result, retry) {
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
    "1. Confirm the main checkout is clean (git status); if dirty, STOP and report.",
    "   If it is clean and on " + BASE_BRANCH + ", check out " + integrationBranch,
    "   (git checkout " + integrationBranch + "; the branch already exists), then", "   re-confirm the tree is clean. On any other branch, STOP.",
    "2. CONTENT-BASED IDEMPOTENCY CHECK. This decides whether the work is already",
    "   merged. Run: git apply --check --reverse <patch>",
    "   Exit 0 means the captured patch is ALREADY applied to this branch: do NOT",
    "   apply the patch and do NOT commit; skip straight to step 6, report the",
    "   existing commit hash, and finish successfully — the host gate verifies",
    "   content equivalence while ignoring whitespace-only differences, so a",
    "   formatting pre-commit hook cannot make a verified no-op fail (JRB-018).",
    "   A non-zero exit usually means it is NOT applied: continue. But if the",
    "   patch will not forward-apply either (its content is already committed and",
    "   possibly reformatted), verify content equivalence yourself: apply the",
    "   patch to a temp index or worktree at a candidate base (merge-base HEAD " + BASE_BRANCH + ",",
    "   or the parent of the existing ticket commit) and compare with HEAD using",
    "   git diff -w; if the content matches, treat it as already merged and report",
    "   the existing commit hash without committing anything.",
    "   Never decide this from `Issue:` trailer grep or `git log --grep`: a trailer",
    "   proves only that some commit for this ticket exists, not that THIS patch is",
    "   applied (JRB-017: the fix merge was skipped because the implementation",
    "   commit already carried the trailer).",
    "3. Find and apply the captured patch: git apply --whitespace=fix --index <patch>",
    "4. Read the ticket and diff, then create a Conventional Commit subject using the appropriate type and a concise change summary. Include `Issue: " + ticketRef + "` as a commit-body trailer. Do not use a generic 'Implement ticket' subject.",
    "5. Commit using that subject and trailer, then validate both:",
    "   git log -1 --format=%s | grep -Eq '^[a-z][a-z0-9-]*(\\([a-z0-9._/-]+\\))?!?: .+'",
    "   git show -s --format=%B HEAD | grep -Fx 'Issue: " + ticketRef + "'",
    "   If either check fails, amend only the message and re-check.",
    "6. Return: merge status, commit hash, gate result.",
    "   (The orchestrator runs the intermediate gate on the host automatically; do not run it yourself.)",
    "",
    "If the patch cannot be found or applied, report FAILURE clearly and change nothing."
  );
  return runs.run(label, {
    label: label,
    agent: AG.merger,
    task: task.join("\n"),
    timeoutMs: REVIEW_TIMEOUT_MS,
    gate: mergeGate(result),
    agentContract: { version: 1 },
    control: childControl(GATE_TIMEOUT_MS),
    // Merger success is decided by the host-run gate and the commit state,
    // not by a prose acceptance report. acceptance: false keeps the harness
    // from rejecting an otherwise-green merge because the report block was
    // missing (JRB-016: three green merges rejected on report format).
    acceptance: false
  });
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

function respawnReview(stage, axis, attempt) {
  const cfg = REVIEW_AXES.filter(function(a) { return a.name === axis; })[0];
  return runs.run("review-" + stage + "-" + axis + "-retry-" + attempt, {
    label: "Review " + axis + " axis (" + stage + " retry " + attempt + ")",
    agent: cfg.agent,
    task: reviewAxisTask(axis, cfg.focus, integrationBranch, BASE_BRANCH, REPO_PATH, ticketRef),
    timeoutMs: REVIEW_TIMEOUT_MS,
    control: childControl(REVIEW_TIMEOUT_MS)
    // No run-level outputSchema: the reviewer agent's frontmatter carries the
    // verdict schema, so ad-hoc re-spawns get the same contract.
  });
}

function spawnReviews(stage) {
  return Promise.all(REVIEW_AXES.map(function(a) {
    const key = "review-" + stage + "-" + a.name;
    return Promise.resolve().then(function() {
      return runs.run(key, {
        label: "Review " + a.name + " axis (" + stage + ")",
        agent: a.agent,
        task: reviewAxisTask(a.name, a.focus, integrationBranch, BASE_BRANCH, REPO_PATH, ticketRef),
        timeoutMs: REVIEW_TIMEOUT_MS,
        control: childControl(REVIEW_TIMEOUT_MS)
      });
    }).then(function(result) {
      return reviewRecord(a.name, result);
    }).catch(function(error) {
      return reviewRecord(a.name, { ok: false, error: String(error), output: "" });
    });
  }));
}

function retryUnverdicts(stage, reviews, attempt) {
  const retryAxes = reviews.filter(function(review) { return review.verdict === "UNVERDICTED"; });
  if (!retryAxes.length || attempt >= MAX_REVIEW_RETRIES) return Promise.resolve(reviews);
  const nextAttempt = attempt + 1;
  emit("implement: retrying UNVERDICTED review axes: " +
       retryAxes.map(function(review) { return review.axis; }).join(", ") +
       " (attempt " + nextAttempt + "/" + MAX_REVIEW_RETRIES + ")");
  return Promise.all(retryAxes.map(function(review) {
    return Promise.resolve().then(function() {
      return respawnReview(stage, review.axis, nextAttempt);
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
    return retryUnverdicts(stage, reviews, nextAttempt);
  });
}

function runReviewPhase(stage) {
  return spawnReviews(stage).then(function(reviews) {
    return retryUnverdicts(stage, reviews, 0);
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
    "Record verification evidence under `## Agent Execution Evidence` / `### Independent Verification`",
    "in the ticket description, following docs/agents/issue-tracker.md. Reconcile, never append:",
    "fetch the description first; replace/merge your own section in place (one section, latest",
    "content, timestamped; never duplicate headers), and CORRECT stale or contradictory prior",
    "evidence in place — a stale note left behind is a defect, not a cosmetic issue. Do not",
    "change lifecycle status or acceptance outcomes. Do NOT edit code, commit,",
    "or spawn subagents. Trace shared-file consumers and verify affected adjacent workflows too.",
    "",
    "Finish by calling structured_output:",
    "- verdict: OK when every criterion is satisfied, UNMET when at least one is not;",
    "- criteria: one entry per criterion (criterion, satisfied, evidence);",
    "- unmet: when verdict is UNMET, name the unmet criteria.",
    "A missing or malformed structured verdict counts as NOT verified."
  );
  return runs.run("verify", {
    label: "Verify " + ticketRef + " against committed code",
    agent: AG.verifier,
    task: task.join("\n"),
    timeoutMs: REVIEW_TIMEOUT_MS,
    control: childControl(REVIEW_TIMEOUT_MS)
  });
}

function spawnFinalGate() {
  const task = [
    "The host runs the final full verification gate on " + integrationBranch + ".",
    "Do not edit, stage, commit, or run the gate yourself. Report context only.",
    "Full gate: " + (FULL_GATE && FULL_GATE.command)
  ];
  task.push.apply(task, checkoutHint(REPO_PATH));
  const taskText = task.join("\n");
  return runs.run("final-gate", {
    label: "Run final full gate on " + integrationBranch,
    agent: AG.worker,
    task: taskText,
    timeoutMs: GATE_TIMEOUT_MS + 120000,
    gate: hostGate("cd " + shellQuote(REPO_PATH) + " && test \"$(git branch --show-current)\" = " + shellQuote(integrationBranch) + " && (" + FULL_GATE.command + ")", GATE_TIMEOUT_MS),
    agentContract: { version: 1 },
    control: childControl(GATE_TIMEOUT_MS),
    // The host-run gate result decides pass/fail; the child's prose is only
    // context. Do not let a missing report block a green gate (JRB-016).
    acceptance: false
  });
}

function spawnPrWriter(waiverReason, blockedReviews) {
  const task = [
    PR_INSTRUCTIONS
      ? PR_INSTRUCTIONS
      : "Open this repo's pull request for " + integrationBranch +
        ", using the command recorded in docs/agents/verification.md.",
    ""
  ];
  if (waiverReason) {
    task.push(
      "This PR is explicitly waived by the user, not green-gated.",
      "Open it as a draft, if this repo's request surface supports drafts, and include the waiver reason and unresolved review findings in the body.",
      "Waiver reason: " + waiverReason,
      "Unresolved review findings: " + JSON.stringify(blockedReviews || [])
    );
  }
  task.push.apply(task, checkoutHint(REPO_PATH));
  task.push(
    "",
    "Read docs/agents/issue-tracker.md for ticket and lifecycle behavior, and docs/agents/verification.md for the request surface.",
    "Branch: " + integrationBranch + " -> " + BASE_BRANCH + ", covering " + ticketRef + ".",
    "The ticket at " + ticketRef + " holds the acceptance answer.",
    "Push the head branch first (git push -u origin " + integrationBranch + ")",
    "if it is not on the remote.",
    "Finish by calling structured_output:",
    "- prUrl: the request URL when a request was opened;",
    "- noPrSurface: true when this repo has no request surface (leave the work on",
    "  the integration branch).",
    "Report failure clearly if a request was expected but could not be opened."
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
let lastFailureSignature = null;

// Pre-flight: the checkout must be clean before any child work starts.
// Worktree admission and the merger both assume a clean parent checkout, and
// the JRB-014 run burned its entire remediation ladder on three worktree-
// admission failures caused by two untracked leftover files. Fail loudly here
// instead and let the user resolve the tree.
if (!finalizeMergedPR) {
  if (!REPO_PATH) {
    emit("implement: WARNING - no repoPath arg; the clean-tree preflight cannot run");
  } else {
    const preflight = await runs.run("preflight-clean-tree", {
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
    if (!hostVerified(preflight)) {
      return {
        ok: false,
        ticket: ticketRef,
        dirtyTree: true,
        error: "DIRTY_TREE: the checkout " + REPO_PATH + " has uncommitted or untracked changes. " +
          "Resolve them manually (commit, stash, or remove) and relaunch. No child work started." +
          (preflight && preflight.error ? "\nGate detail: " + String(preflight.error).slice(0, 2000) : "")
      };
    }
    emit("implement: preflight clean-tree check passed");
  }
}

// Phase 0: ensure the integration branch exists, then transition to In Progress.
if (REPO_PATH) {
  const ensureBranch = await runs.run("ensure-integration-branch", {
    agent: AG.worker,
    label: "Create integration branch " + integrationBranch + " from " + BASE_BRANCH,
    task: "Ensure the git branch '" + integrationBranch + "' exists in " + REPO_PATH +
      ", creating it from '" + BASE_BRANCH + "' if missing.\n" +
      "1. git -C " + REPO_PATH + " rev-parse --verify refs/heads/" + integrationBranch +
      " -> if it succeeds, done.\n" +
      "2. If it does not: git -C " + REPO_PATH + " branch " + integrationBranch + " " + BASE_BRANCH +
      " && git -C " + REPO_PATH + " push -u origin " + integrationBranch +
      " 2>/dev/null || true.\n" +
      "3. Change nothing else. Do not switch branches or modify files.\n" +
      "The host gate re-checks the branch after your run.",
    timeoutMs: 30 * 1000,
    quiet: true,
    // The branch's existence is a deterministic host fact: the gate verifies
    // it after the child runs, so no reported token is trusted.
    gate: hostGate("git -C " + shellQuote(REPO_PATH) + " rev-parse --verify " + shellQuote(baseRef), 30 * 1000),
    agentContract: { version: 1 }, acceptance: false
  });
  if (!hostVerified(ensureBranch)) {
    return {
      ok: false,
      ticket: ticketRef,
      error: "Could not ensure integration branch '" + integrationBranch + "' in " + REPO_PATH +
        ". Worktree children branch from it and would all fail. Fix the checkout and relaunch." +
        (ensureBranch && ensureBranch.error ? " Gate detail: " + String(ensureBranch.error).slice(0, 1000) : ""),
      branchSetupFailed: true
    };
  }
  emit("implement: integration branch '" + integrationBranch + "' ensured (gate verified)");
}

// Grooming preflight is a gate, not a warning. The lead can groom through the
// repository's documented issue-tracker workflow and then relaunch.
const groomCheck = await runs.run("groom-check-" + keyOf(ticketRef), {
    agent: AG.worker,
    label: "Validate ticket " + ticketRef + " is groomed",
    task: "Read docs/agents/issue-tracker.md and inspect ticket " + ticketRef +
      " using the documented tracker workflow. " + (TRACKER_HINT || "") + "\n" +
      "Check whether the ticket is ready for implementation, including the documented grooming fields and acceptance criteria.\n" +
      "Finish by calling structured_output: groomed (true when ready, false when the lead must groom it) and missing (the absent grooming fields, when any). Do not change the issue or repository.",
    timeoutMs: TRANSITION_TIMEOUT_MS,
    quiet: true,
    outputSchema: GROOM_OUTPUT_SCHEMA,
    acceptance: false
  });
if (!groomCheck || !groomCheck.ok) {
  return { ok: false, ticket: ticketRef, error: "Could not verify grooming for " + ticketRef + ". No implementation started." };
}
const groomed = !!(groomCheck.structuredOutput && groomCheck.structuredOutput.groomed === true);
if (!groomed) {
  return {
    ok: false,
    ticket: ticketRef,
    groomingRequired: true,
    error: "Ticket " + ticketRef + " is not groomed" +
      (groomCheck.structuredOutput && groomCheck.structuredOutput.missing
        ? " (missing: " + groomCheck.structuredOutput.missing + ")" : "") +
      ". Follow docs/agents/issue-tracker.md or /groom, then relaunch. No implementation started."
  };
}
emit("implement: ticket " + ticketRef + " is groomed");
const inProgressTransition = await runTransition("in_progress", ticketRef, { branch: integrationBranch });
if (!inProgressTransition || !inProgressTransition.ok) {
  return {
    ok: false,
    ticket: ticketRef,
    error: "Could not transition " + ticketRef + " to In Progress. No implementation started.",
    transition: inProgressTransition
  };
}

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
  // Identical-failure dedup: if this failure's normalized signature matches
  // the previous attempt's, retrying is pointless — escalate immediately
  // instead of burning the remaining ladder (JRB-014: three identical
  // worktree-admission failures consumed maxRemediations before escalating).
  const signature = failureSignature(implResult);
  if (lastFailureSignature !== null && lastFailureSignature === signature) {
    return {
      ok: false,
      error: "ESCALATION: implementer for " + ticketRef + " failed again with an IDENTICAL " +
        "failure signature — further remediation is pointless (" + cls + "). Last error: " +
        (implResult && implResult.error || "unknown") +
        " | Lead decision needed.",
      escalated: true,
      ticket: ticketRef,
      failureClass: cls,
      runId: implResult && implResult.runId
    };
  }
  lastFailureSignature = signature;
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
const mergeErrors = [];
try {
  mergeResult = await spawnMerger(implResult);
} catch (e) {
  if (isConfigError(e)) {
    return {
      ok: false,
      error: "implement config error while launching merger: " + String(e),
      configError: true
    };
  }
  mergeErrors.push(String(e));
  emit("implement: merger for " + ticketRef + " rejected (" + e + ")");
}
if (!hostVerified(mergeResult)) {
  mergeErrors.push((mergeResult && mergeResult.error) ? String(mergeResult.error) : "merger returned no host proof");
  // One idempotent retry — a transient lock or race on the checkout.
  try {
    mergeResult = await spawnMerger(implResult, 2);
  } catch (e2) {
    mergeErrors.push(String(e2));
    emit("implement: merger retry rejected (" + e2 + ")");
  }
}
if (!hostVerified(mergeResult)) {
  if (mergeResult && mergeResult.error) mergeErrors.push(String(mergeResult.error));
  return {
    ok: false,
    error: "ESCALATION: " + ticketRef + " was implemented but the merger FAILED to commit its work. " +
      "The implementer's retained worktree still holds uncommitted changes. " +
      "Each gate attempt's MERGE_GATE_FAIL label (in mergeErrors) names the exact failed clause — " +
      "diagnose from it before relaunching. Lead decision needed before any PR.",
    escalated: true,
    ticket: ticketRef,
    failureClass: "merge",
    runId: implResult && implResult.runId,
    mergeErrors: mergeErrors.map(function(e) { return String(e).slice(0, 800); })
  };
}

// Phase 2: review both axes, preserving each result if another child fails.
let reviews = await runReviewPhase("initial");
let reviewSummary = summarizeReviews(reviews);
let blockedAxes = reviewSummary.blockedAxes;
let reviewsIncomplete = reviewSummary.reviewsIncomplete;
let fixApplied = false;
let fixMerged = false;

if (blockedAxes.length && !(PR_WAIVER_REASON && !skipPR)) {
  // Fix pass: worktree-isolated, repairs review findings.
  const fixBrief = [
    "Reviewers BLOCKED the work on " + integrationBranch + ".",
    "Findings (excerpts):",
    JSON.stringify(blockedAxes, null, 2),
    "",
    "Fix must-fix defects in YOUR managed worktree (already branched from",
    integrationBranch + "), keep the intermediate gate green: " + (NARROW_GATE && NARROW_GATE.command),
    "",
    "Run the repo's configured pre-commit formatter over the files you changed before finishing (see .pre-commit-config.yaml; the command is in docs/agents/verification.md or CODING_STANDARDS.md), then re-run the gate: the merger's commit-time hook reformats anything left unformatted (JRB-018).",
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
      gate: gateObj(NARROW_GATE.command, GATE_TIMEOUT_MS),
      control: childControl(GATE_TIMEOUT_MS)
    });
  } catch (eFx) {
    emit("implement: fix-review-findings rejected (" + eFx + ")");
  }

  if (fixResult && fixResult.ok) {
    fixApplied = true;
    let fixMergerResult = null;
    try {
      fixMergerResult = await spawnMerger(fixResult, "fix");
    } catch (eM) {
      emit("implement: merge-review-fixes rejected (" + eM + ")");
    }
    fixMerged = hostVerified(fixMergerResult);
    if (!fixMerged) {
      // A merger can fail after committing. Recheck the exact captured patch,
      // issue commit and tests on the host before treating it as merged.
      const gmVerify = await runs.run("verify-fix-merge-" + keyOf(ticketRef), {
        agent: AG.worker,
        label: "Verify fix-merge git state for " + ticketRef,
        task: "The merge-review-fixes child reported failure, but its work may already be committed. " +
          "Confirm: (1) checkout is on " + integrationBranch + " and clean; " +
          "(2) the fixer's changes are present (git log --oneline main.." + integrationBranch +
          " shows commits beyond the original implementation); (3) the intermediate gate " + (NARROW_GATE && NARROW_GATE.command) +
          " passes. The host gate independently checks the captured patch, " +
          "issue commit, and test command; your output is diagnostic only. " + checkoutHint(REPO_PATH),
        timeoutMs: GATE_TIMEOUT_MS + 120000,
        gate: mergeGate(fixResult),
        control: childControl(GATE_TIMEOUT_MS),
        quiet: true,
        agentContract: { version: 1 },
        acceptance: false
      }).catch(function(e) {
        emit("implement: fix-merge verification rejected (" + e + ")");
        return null;
      });
      if (hostVerified(gmVerify)) {
        emit("implement: fix-merge host postconditions verified; treating as merged");
        fixMerged = true;
      } else {
        return {
          ok: false,
          error: "ESCALATION: review findings were fixed but NOT merged into " +
            integrationBranch + " — the fixer's worktree holds uncommitted work, and " +
            "the git-state verification did not confirm it is on the branch. " +
            "Gate label: " + String((gmVerify && gmVerify.error) || "unknown").slice(0, 500) + ". " +
            "Lead decision needed before any PR.",
          escalated: true,
          ticket: ticketRef,
          failureClass: "merge",
          gateDetail: String((gmVerify && gmVerify.error) || "").slice(0, 2000)
        };
      }
    }
    reviews = await runReviewPhase("post-fix");
    reviewSummary = summarizeReviews(reviews);
    blockedAxes = reviewSummary.blockedAxes;
    reviewsIncomplete = reviewSummary.reviewsIncomplete;
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

const reviewsOk = !reviewsIncomplete && blockedAxes.length === 0;
const waivedReviewBlock = !skipPR && !reviewsOk && !reviewsIncomplete && blockedAxes.length > 0 && !!PR_WAIVER_REASON;
if (!reviewsOk && !waivedReviewBlock) {
  return {
    ok: false,
    error: "ESCALATION: review is incomplete or blocked for " + ticketRef + ". PR suppressed. " +
      (reviewsIncomplete ? "An axis returned no structured verdict (treated as INCOMPLETE, not a pass)." : ""),
    escalated: true,
    ticket: ticketRef,
    reviews: reviews,
    reviewsIncomplete: reviewsIncomplete
  };
}

// Phase 3: independent verification of the ticket's acceptance criteria.
let verifyResult = null;
try {
  verifyResult = await spawnVerifier();
} catch (eVer) {
  emit("implement: verifier launch rejected (" + eVer + ")");
}
const verificationVerdict = (verifyResult && verifyResult.ok &&
  verifyResult.structuredOutput && verifyResult.structuredOutput.verdict)
  ? verifyResult.structuredOutput.verdict
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

// Phase 4: full gate on the final reviewed commit, before the PR.
let finalGateResult = null;
try {
  finalGateResult = await spawnFinalGate();
} catch (eGate) {
  emit("implement: final full gate rejected (" + eGate + ")");
}
const fullGatePassed = hostVerified(finalGateResult);
if (!fullGatePassed) {
  return {
    ok: false,
    error: "ESCALATION: final full gate failed on " + integrationBranch + ". PR suppressed.",
    escalated: true,
    ticket: ticketRef,
    fullGatePassed: false,
    finalGate: finalGateResult && finalGateResult.output ? String(finalGateResult.output).slice(0, 2000) : null
  };
}

let prResult = null;
let readyTransition = null;
let prUrl = null;
let prSurfaceUnavailable = false;
if (!skipPR) {
  try {
    prResult = await spawnPrWriter(waivedReviewBlock ? PR_WAIVER_REASON : "", blockedAxes);
    const requestResult = parsePrWriterResult(prResult);
    prSurfaceUnavailable = NO_PR_SURFACE && !!(prResult && prResult.ok && requestResult.noPrSurface && !requestResult.url);
    if (prResult && prResult.ok && requestResult.url && !requestResult.noPrSurface && PR_CHECK_COMMAND) {
      const confirmed = await runs.run("confirm-pr", {
        agent: AG.worker,
        label: "Check PR for " + ticketRef,
        task: "Change nothing; the host gate verifies that the request exists.",
        quiet: true,
        gate: hostGate(checkedCommand(PR_CHECK_COMMAND, { PR_URL: requestResult.url, BRANCH: integrationBranch }), TRANSITION_TIMEOUT_MS),
        agentContract: { version: 1 }, acceptance: false
      });
      if (hostVerified(confirmed)) prUrl = requestResult.url;
    }
  } catch (eP) {
    emit("implement: pr-writer rejected (" + eP + ")");
  }
  if (prResult && prResult.ok && prUrl && !waivedReviewBlock) {
    readyTransition = await runTransition("ready_for_review", ticketRef, { branch: integrationBranch, prUrl: prUrl });
    if (!readyTransition || !readyTransition.ok) {
      return {
        ok: false,
        prCreated: true,
        ticket: ticketRef,
        prUrl: prUrl,
        error: "PR was created, but the issue could not be transitioned to Ready for Review.",
        transition: readyTransition
      };
    }
  }
}

const prFailed = !skipPR && !(prResult && prResult.ok && (prUrl || prSurfaceUnavailable));
const workflowComplete = !waivedReviewBlock && !prFailed;

// Preserve worktrees after an incomplete or waived run so the lead can resume them.
if (REPO_PATH && workflowComplete) {
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

emit("implement: " + ticketRef + " verified on " + integrationBranch +
     ", " + (skipPR ? "PR skipped" : (prUrl ? (waivedReviewBlock ? "PR opened under an explicit waiver" : "PR created; awaiting merge") : (prSurfaceUnavailable ? "no PR surface; branch complete" : "PR failed"))));

return {
  ok: workflowComplete,
  ticket: ticketRef,
  integrationBranch: integrationBranch,
  baseBranch: BASE_BRANCH,
  gate: FULL_GATE,
  fullGate: FULL_GATE,
  narrowGate: NARROW_GATE,
  fullGatePassed: fullGatePassed,
  remediationAttempts: remediationAttempt,
  reviews: reviews,
  verification: verificationVerdict,
  fixApplied: fixApplied,
  fixMerged: fixMerged,
  prCreated: !!(prResult && prResult.ok && prUrl),
  prSurfaceUnavailable: prSurfaceUnavailable,
  prUrl: prUrl,
  prWaived: waivedReviewBlock,
  prWaiverReason: waivedReviewBlock ? PR_WAIVER_REASON : null,
  prFailed: prFailed,
  awaitingMerge: !!(prResult && prResult.ok && prUrl && !waivedReviewBlock),
  prOutput: prResult && prResult.output ? prResult.output.slice(0, 400) : null,
  runIds: {
    implementer: implResult && implResult.runId,
    verifier: verifyResult && verifyResult.runId
  }
};
