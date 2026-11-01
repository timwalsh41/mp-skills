import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../skills/engineering/", import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function executeWorkflow(skill, args, options = {}) {
  const path = new URL(`${skill}/orchestrate.js`, root);
  const source = await readFile(path, "utf8");
  const calls = [];
  const runs = {
    run(key, config = {}) {
      const call = { key: String(key), ...config };
      calls.push(call);
      return Promise.resolve().then(() => {
        if (options.cacheKeys && options.cacheKeys.has(call.key)) return options.cacheKeys.get(call.key);
        const response = responseFor(call, { ...options, ticketGraph: args.ticketGraph });
        if (options.mergeAction && call.agent === "merger" && call.key.startsWith("merge-")) options.mergeAction(call);
        if (options.runHostGates && response.ok && call.gate && (!options.gateFilter || options.gateFilter(call))) {
          const gate = spawnSync("sh", ["-c", call.gate.command], { cwd: options.gateCwd || args.repoPath, encoding: "utf8" });
          if (gate.status !== 0) return { ok: false, error: `host gate failed: ${gate.stderr || gate.stdout}` };
          if (call.gate.output === "json") {
            try { response.structuredOutput = JSON.parse(gate.stdout); }
            catch { return { ok: false, error: "invalid typed host gate JSON" }; }
          }
        } else if (call.gate?.output === "json" && response.ok && !options.missingHostProof?.(call)) {
          response.structuredOutput = { verified: true };
        }
        if (options.cacheKeys) options.cacheKeys.set(call.key, response);
        return response;
      });
    },
    all(promises) {
      return Promise.all(promises).then((results) => {
        const failed = results.find((result) => !result?.ok);
        if (failed) throw new Error(failed.error || "child run failed");
        return results;
      });
    },
  };
  const execute = new AsyncFunction("args", "runs", "emit", source);
  const result = await execute(args, runs, () => {});
  return { calls, result };
}

function responseFor(call, options) {
  const { key, label = "", task = "" } = call;
  if (key === "ensure-integration-branch") return { ok: true, runId: "r-ensure", output: "branch ensured" };
  if (key === "preflight-clean-tree") {
    // The orchestrator decides the tree state from the host-run gate, so a
    // dirty tree surfaces as a failed run, not as prose.
    return options.dirtyTree
      ? { ok: false, error: "gate failed: DIRTY_TREE ?? leftover.py" }
      : { ok: true, runId: "r-preflight", output: "clean" };
  }
  if (key.startsWith("groom-check-")) {
    return {
      ok: true,
      runId: "r-groom",
      output: "groom check done",
      structuredOutput: { groomed: options.groomed !== false, missing: options.groomed === false ? "approach,test plan" : "" },
    };
  }
  if (key === "ticket-graph-forced" || key === "ticket-graph") {
    return { ok: true, runId: "r-graph", output: options.graphOutput ?? "graph discovered", structuredOutput: options.graphOutput === undefined ? options.ticketGraph : undefined };
  }
  if (key === "confirm-merge" || key.startsWith("verify-merge-") || key.startsWith("confirm-merge-")) {
    return {
      ok: true,
      runId: "r-confirm",
      output: "merge confirmation checked",
      structuredOutput: { confirmed: options.mergeConfirmed !== false, evidence: "tracker state" },
    };
  }
  if (key.startsWith("transition-")) {
    const phase = key.split("-")[1];
    return {
      ok: true,
      runId: "r-transition",
      output: "transition attempted",
      structuredOutput: { outcome: options.transitionFailPhase === phase ? "TRANSITION_FAILED" : "TRANSITION_APPLIED", resultingStatus: "In Progress" },
    };
  }
  if (key === "fix-review-findings") {
    return options.reviewFixPass === false
      ? { ok: false, error: "review fix did not pass", output: "failed" }
      : { ok: true, runId: "r-fix-review", output: "review fixes ready" };
  }
  if (key === "merge-review-fixes" && options.fixMergeFail) {
    return { ok: false, error: "merge rejected: simulated", output: "failed" };
  }
  if (key.startsWith("fix-t") || /^fix-\d+-t/.test(key)) {
    return options.fixFail
      ? { ok: false, error: options.fixFail, output: "failed" }
      : { ok: true, runId: "r-fix", output: "fix applied" };
  }
  if (key === "final-verify" || key === "final-gate") {
    return options.finalVerifyPass === false || options.finalGatePass === false
      ? { ok: false, error: "full suite failed", output: "FAILED" }
      : { ok: true, runId: "r-final-gate", output: "full suite passed" };
  }
  if (key.startsWith("verify-fix-merge-")) {
    return {
      ok: true,
      runId: "r-verify-fix-merge",
      output: "fix-merge state checked",
      ...(options.fixMergeMissing ? { ok: false, error: "captured patch missing" } : {}),
    };
  }
  if (key === "verify" || key.startsWith("verify-") || key.startsWith("verify-post-fix")) {
    if (label.startsWith("Verify ")) {
      return { ok: true, runId: "r-verify", output: "verified", structuredOutput: { verdict: "OK", criteria: [] } };
    }
  }
  if (key.startsWith("review-")) {
    const configured = options.reviewByKey?.[key];
    if (configured?.error) throw new Error(configured.error);
    const verdict = typeof configured === "string" ? configured : options.reviewVerdict || "OK";
    return {
      ok: true,
      runId: "r-review",
      output: "simulated review finding",
      structuredOutput: { verdict, findings: "simulated review finding" },
    };
  }
  if (key === "pr") {
    if (options.prFail) return { ok: false, error: "request creation failed", output: "PR_FAILED" };
    return {
      ok: true,
      runId: "r-pr",
      output: "request opened",
      structuredOutput: options.noPrSurface ? { noPrSurface: true } : { prUrl: "https://example.test/pull/42", noPrSurface: false },
    };
  }
  if (options.failFirstMerge && key.endsWith("-attempt-1") && key.startsWith("merge-")) {
    return { ok: false, error: "simulated merge failure" };
  }
  if (key.startsWith("cleanup")) return { ok: true, runId: "r-cleanup", output: "WORKTREES_CLEANED" };
  if (label.startsWith("Validate ticket ")) {
    return {
      ok: true,
      runId: "r-groom",
      output: "groom check done",
      structuredOutput: { groomed: options.groomed !== false, missing: "" },
    };
  }
  if (label.startsWith("Implement ticket ") || label.startsWith("Implement JRB-")) {
    if (options.implFail || options.implFailByKey?.[key]) return { ok: false, error: options.implFailByKey?.[key] || options.implFail, output: "failed" };
    return { ok: true, runId: "r-impl", output: "implementation complete", artifactPaths: options.implArtifactPaths };
  }
  if (label.startsWith("Merge ticket ") || label.startsWith("merge-") || label.startsWith("Commit and merge")) {
    return { ok: true, runId: "r-merge", output: "merge complete" };
  }
  if (label.startsWith("Transition ")) {
    return { ok: true, runId: "r-transition", output: "transition attempted", structuredOutput: { outcome: "TRANSITION_APPLIED" } };
  }
  return { ok: true, runId: "r-child", output: "ok" };
}

function singleArgs(overrides = {}) {
  return {
    ticketRef: "JRB-012",
    gate: "npm test",
    integrationBranch: "feature/JRB-012-modal-dismissal",
    baseBranch: "main",
    repoPath: "/repo",
    trackerHint: "Read docs/agents/issue-tracker.md for issue operations.",
    transitionCheckCommands: { in_progress: "true", ready_for_review: "true", complete: "true" },
    prCheckCommand: "true", mergeCheckCommand: "true",
    ...overrides,
  };
}

function specArgs(ticketGraph, overrides = {}) {
  return {
    specRef: "JRB-001 (epic)",
    ticketsRef: "JRB-001 children",
    integrationBranch: "feature/jrb-001-integration",
    fullGate: "npm test",
    narrowGate: "npm run test:unit",
    baseBranch: "main",
    repoPath: "/repo",
    trackerHint: "Read docs/agents/issue-tracker.md for issue operations.",
    maxParallel: 1,
    maxWaves: 1,
    ticketGraph: ticketGraph,
    transitionCheckCommands: { in_progress: "true", ready_for_review: "true", complete: "true" },
    prCheckCommand: "true", mergeCheckCommand: "true",
    ...overrides,
  };
}

const oneTicket = {
  tickets: [
    { ref: "JRB-012", title: "Close link modal without refresh", resolved: false, blockedBy: [], onBranch: false, groomed: true, type: "Bug" },
  ],
  preflight: { trackerConfigured: true, integrationBranchExists: true, integrationBranch: "feature/jrb-001-integration" },
};

test("implement defaults to tracker-doc transitions and does not complete on PR creation", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs());
  assert.equal(result.prCreated, true);
  const transitionTasks = calls.filter((call) => call.key.startsWith("transition-"));
  assert.ok(transitionTasks.some((call) => call.key.includes("in_progress")));
  assert.ok(transitionTasks.some((call) => call.key.includes("ready_for_review")));
  assert.ok(!transitionTasks.some((call) => call.key.includes("complete")));
  assert.ok(transitionTasks.every((call) => call.task.includes("docs/agents/issue-tracker.md")));
  assert.ok(calls.findIndex((call) => call.key.includes("transition-in_progress")) < calls.findIndex((call) => call.key.startsWith("impl-")));
  assert.ok(calls.findIndex((call) => call.key === "pr") < calls.findIndex((call) => call.key.includes("transition-ready_for_review")));
});

test("implement reports a tracker with no PR surface without marking Ready for Review", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs({ noPrSurface: true }), { noPrSurface: true });
  assert.equal(result.ok, true);
  assert.equal(result.prCreated, false);
  assert.equal(result.prSurfaceUnavailable, true);
  assert.ok(!calls.some((call) => call.key.includes("transition-ready_for_review")));
});

test("implement retains recovery worktrees when PR creation fails", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs(), { prFail: true });
  assert.equal(result.ok, false);
  assert.equal(result.prFailed, true);
  assert.ok(!calls.some((call) => call.key.startsWith("cleanup")));
});

test("implement only completes a ticket after the tracker confirms merged state", async () => {
  const pending = await executeWorkflow("implement", singleArgs({ finalizeMergedPR: true, prUrl: "https://example.test/pull/42" }), { mergeConfirmed: false });
  assert.equal(pending.result.ok, false);
  assert.ok(!pending.calls.some((call) => call.key.includes("transition-complete")));

  const merged = await executeWorkflow("implement", singleArgs({ finalizeMergedPR: true, prUrl: "https://example.test/pull/42" }));
  assert.equal(merged.result.ok, true);
  assert.ok(merged.calls.some((call) => call.key.includes("transition-complete")));
  assert.ok(!merged.calls.some((call) => call.key.startsWith("impl-")));
});

test("implement stops before implementation when ticket grooming is required", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs(), { groomed: false });
  assert.equal(result.ok, false);
  assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
});

test("implement merger requests a Conventional Commit subject and issue trailer", async () => {
  const { calls } = await executeWorkflow("implement", singleArgs());
  const merge = calls.find((call) => call.key.startsWith("merge-"));
  assert.ok(merge);
  assert.match(merge.task, /Conventional Commit/i);
  assert.match(merge.task, /git log -1 --format=%s/);
  assert.match(merge.task, /Issue: JRB-012/);
});

test("implement aborts on a dirty checkout before any child work", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs(), { dirtyTree: true });
  assert.equal(result.ok, false);
  assert.equal(result.dirtyTree, true);
  assert.match(result.error, /DIRTY_TREE/);
  assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
  assert.ok(!calls.some((call) => call.key.startsWith("fix-")));
  assert.ok(!calls.some((call) => call.key === "ensure-integration-branch"));
});

test("implement skips the clean-tree preflight in finalize mode", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs({ finalizeMergedPR: true, prUrl: "https://example.test/pull/42" }));
  assert.equal(result.ok, true);
  assert.ok(!calls.some((call) => call.key === "preflight-clean-tree"));
});

test("implement transitions use the 180s budget and carry the evidence firewall", async () => {
  const { calls } = await executeWorkflow("implement", singleArgs());
  const transitionTasks = calls.filter((call) => call.key.startsWith("transition-"));
  assert.ok(transitionTasks.length > 0);
  assert.ok(transitionTasks.every((call) => call.timeoutMs === 180000));
  assert.ok(transitionTasks.every((call) => /Record nothing anywhere/.test(call.task)));
  assert.ok(transitionTasks.every((call) => /Agent Execution Evidence/.test(call.task)));
});

test("implement escalates immediately when remediation fails with an identical failure signature", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs(), {
    implFail: "worktree admission failed: dirty checkout",
    fixFail: "worktree admission failed: dirty checkout",
  });
  assert.equal(result.ok, false);
  assert.equal(result.escalated, true);
  assert.match(result.error, /IDENTICAL/);
  const fixers = calls.filter((call) => call.key.startsWith("fix-t"));
  assert.equal(fixers.length, 1);
});

test("implement keeps remediating when failures have different signatures", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs(), {
    implFail: "worktree admission failed: dirty checkout",
    fixFail: "gate failed: 3 tests broken",
  });
  assert.equal(result.ok, false);
  assert.equal(result.escalated, true);
  const fixers = calls.filter((call) => call.key.startsWith("fix-t"));
  assert.equal(fixers.length, 2);
});

test("implement-spec suppresses PR when final verification fails, even with a waiver", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket, { prWaiverReason: "Allow review gap only." }), { finalVerifyPass: false });
  assert.equal(result.prCreated, false);
  assert.ok(!calls.some((call) => call.key === "pr"));
  const finalVerify = calls.find((call) => call.key === "final-verify");
  assert.match(finalVerify.task, /Full gate: npm test/);
  assert.match(finalVerify.task, /Do not edit/);
  assert.ok(!calls.some((call) => call.key.startsWith("cleanup")));
});

test("implement-spec suppresses PR when any in-scope ticket remains unresolved", async () => {
  const graph = structuredClone(oneTicket);
  graph.tickets.push({ ref: "JRB-013", title: "Another slice", resolved: false, blockedBy: [], onBranch: false, groomed: true, type: "Story" });
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(graph, { maxParallel: 1, maxWaves: 1, prWaiverReason: "Allow partial work." }));
  assert.ok(result.unresolved.includes("JRB-013"));
  assert.equal(result.prCreated, false);
  assert.ok(!calls.some((call) => call.key === "pr"));
  assert.ok(!calls.some((call) => call.key.startsWith("cleanup")));
});

test("implement-spec defaults to tracker-doc transitions and waits for merge before completion", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket));
  assert.equal(result.prCreated, true);
  const transitionTasks = calls.filter((call) => call.key.startsWith("transition-"));
  assert.ok(transitionTasks.some((call) => call.key.includes("in_progress")));
  assert.ok(transitionTasks.some((call) => call.key.includes("ready_for_review")));
  assert.ok(!transitionTasks.some((call) => call.key.includes("complete")));
  assert.ok(transitionTasks.every((call) => call.task.includes("docs/agents/issue-tracker.md")));
});

test("implement-spec leaves the integration branch when the tracker has no PR surface", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket, { noPrSurface: true }), { noPrSurface: true });
  assert.equal(result.ok, true);
  assert.equal(result.prCreated, false);
  assert.equal(result.prSurfaceUnavailable, true);
  assert.ok(!calls.some((call) => call.key.includes("transition-ready_for_review")));
});

test("implement-spec retains worktrees when request creation fails", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), { prFail: true });
  assert.equal(result.ok, false);
  assert.equal(result.prFailed, true);
  assert.ok(!calls.some((call) => call.key.startsWith("cleanup")));
});

test("implement-spec verify-only resumes branch work while the tracker is still open", async () => {
  const graph = structuredClone(oneTicket);
  graph.tickets[0].onBranch = true;
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(graph, { verifyOnly: true }));
  assert.ok(result.merged.includes("JRB-012"));
  assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
});

test("implement-spec merger instructions preserve Conventional Commit ticket identity", async () => {
  const { calls } = await executeWorkflow("implement-spec", specArgs(oneTicket));
  const merge = calls.find((call) => call.key.startsWith("merge-"));
  assert.ok(merge);
  assert.match(merge.task, /Conventional Commit/i);
  assert.match(merge.task, /git log -1 --format=%s/);
  assert.match(merge.task, /Issue: JRB-012/);
  const scout = calls.find((call) => call.key === "ticket-graph-forced");
  assert.match(scout.task, /Issue: <ref>/);
  assert.match(scout.task, /legacy commits/);
});

test("implement-spec does not dispatch an ungroomed issue", async () => {
  const graph = structuredClone(oneTicket);
  graph.tickets[0].groomed = false;
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(graph));
  assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
  assert.equal(result.prCreated, false);
  assert.ok(result.unresolved.includes("JRB-012"));
});

test("implement-spec completes issues only after merge confirmation, even if the remote branch was deleted", async () => {
  const graph = structuredClone(oneTicket);
  graph.tickets[0].onBranch = false;
  graph.preflight.integrationBranchExists = false;
  const args = specArgs(graph, { finalizeMergedPR: true, prUrl: "https://example.test/pull/42" });
  const pending = await executeWorkflow("implement-spec", args, { mergeConfirmed: false });
  assert.equal(pending.result.finalized, false);
  assert.ok(!pending.calls.some((call) => call.key.includes("transition-complete")));

  const merged = await executeWorkflow("implement-spec", args);
  assert.equal(merged.result.finalized, true);
  assert.ok(!merged.calls.some((call) => call.key === "ensure-integration-branch"));
  assert.ok(merged.calls.some((call) => call.key.includes("transition-complete")));
  assert.ok(!merged.calls.some((call) => call.key.startsWith("impl-")));

  const updateFailed = await executeWorkflow("implement-spec", args, { transitionFailPhase: "complete" });
  assert.equal(updateFailed.result.finalized, false);
});

test("a failed In Progress transition blocks implementation", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs(), { transitionFailPhase: "in_progress" });
  assert.equal(result.ok, false);
  assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
});

test("implement-spec blocks the batch when In Progress transition fails", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), { transitionFailPhase: "in_progress" });
  assert.equal(result.ok, false);
  assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
  assert.ok(!calls.some((call) => call.key === "pr"));
});

test("implement-spec suppresses a blocked review when no waiver is supplied", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), {
    reviewVerdict: "BLOCK",
    reviewFixPass: false,
  });
  assert.equal(result.prCreated, false);
  assert.equal(result.ok, false);
  assert.ok(!calls.some((call) => call.key === "pr"));
  assert.ok(!calls.some((call) => call.key.startsWith("cleanup")));
});

test("implement-spec accepts only an explicit review waiver and keeps the PR non-green", async () => {
  const { calls, result } = await executeWorkflow(
    "implement-spec",
    specArgs(oneTicket, { prWaiverReason: "Proceed with the documented review gap." }),
    { reviewVerdict: "BLOCK" },
  );
  assert.equal(result.prCreated, true);
  assert.equal(result.prWaived, true);
  assert.equal(result.ok, false);
  const pr = calls.find((call) => call.key === "pr");
  assert.match(pr.task, /explicitly waived/);
  assert.match(pr.task, /draft/);
  assert.match(pr.task, /documented review gap/);
  assert.ok(!calls.some((call) => call.key.includes("transition-ready_for_review")));
  assert.ok(!calls.some((call) => call.key.startsWith("cleanup")));
});

test("a user waiver is explicit, drafts the PR, and never reports a green run", async () => {
  const { calls, result } = await executeWorkflow(
    "implement",
    singleArgs({ prWaiverReason: "Proceed with the known test-coverage gap." }),
    { reviewVerdict: "BLOCK", reviewFixPass: false },
  );
  assert.equal(result.prCreated, true);
  assert.equal(result.prWaived, true);
  assert.equal(result.ok, false);
  const pr = calls.find((call) => call.key === "pr");
  assert.match(pr.task, /explicitly waived/);
  assert.match(pr.task, /draft/);
  assert.match(pr.task, /known test-coverage gap/);
  assert.ok(!calls.some((call) => call.key.includes("transition-ready_for_review")));
  assert.ok(!calls.some((call) => call.key.startsWith("cleanup")));
});

test("implement preserves a passing review when another axis fails and retries only that axis", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs(), {
    reviewByKey: { "review-initial-quality": { error: "provider unavailable" } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reviews.map(({ axis, verdict }) => [axis, verdict]), [
    ["standards", "OK"],
    ["quality", "OK"],
  ]);
  assert.ok(calls.some((call) => call.key === "review-initial-quality-retry-1"));
  assert.ok(!calls.some((call) => call.key === "review-initial-standards-retry-1"));
});

test("implement re-reviews a merged review fix before verification and the final full gate", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs({
    fullGate: "npm run test:full",
    narrowGate: "npm run test:fast",
  }), {
    reviewByKey: {
      "review-initial-standards": "BLOCK",
      "review-post-fix-quality": { error: "temporary provider failure" },
    },
  });
  const fixMerge = calls.findIndex((call) => call.key.startsWith("merge-fix-"));
  const postFixReview = calls.findIndex((call) => call.key === "review-post-fix-standards");
  const verify = calls.findIndex((call) => call.key === "verify");
  const finalGate = calls.findIndex((call) => call.key === "final-gate");
  const pr = calls.findIndex((call) => call.key === "pr");
  assert.ok(fixMerge >= 0 && fixMerge < postFixReview);
  assert.ok(postFixReview < verify && verify < finalGate && finalGate < pr);
  assert.ok(calls.some((call) => call.key === "review-post-fix-quality-retry-1"));
  assert.equal(result.fixMerged, true);
  assert.equal(result.reviews.every((review) => review.verdict === "OK"), true);
  assert.equal(result.fullGatePassed, true);
  assert.equal(result.ok, true);
  assert.equal(calls.find((call) => call.key.startsWith("impl-")).gate.command, "npm run test:fast");
  assert.match(calls.find((call) => call.key.startsWith("merge-")).gate.command, /\(npm run test:fast\).*printf/);
  assert.match(calls.find((call) => call.key === "final-gate").gate.command, /\(npm run test:full\).*printf/);
});

test("implement-spec retries only the reviewer whose initial run failed", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), {
    reviewByKey: { "review-initial-quality-1": { error: "provider unavailable" } },
  });
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.key === "review-initial-quality-1-retry-1"));
  assert.ok(!calls.some((call) => call.key === "review-initial-standards-1-retry-1"));
  const implementer = calls.find((call) => call.label.startsWith("Implement ticket"));
  const merger = calls.find((call) => call.label.startsWith("Merge ticket"));
  assert.equal(implementer.gate.command, "npm run test:unit");
  assert.match(merger.gate.command, /\(npm run test:unit\).*printf/);
  const finalGate = calls.find((call) => call.key === "final-verify");
  assert.match(finalGate.gate.command, /\(npm test\).*printf/);
});

test("implement-spec re-reviews and re-verifies a review fix before its final full gate", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), {
    reviewByKey: { "review-initial-quality-1": "BLOCK" },
  });
  const fixMerge = calls.findIndex((call) => call.key === "merge-review-fixes");
  const postFixReview = calls.findIndex((call) => call.key === "review-post-fix-standards-1");
  const postFixVerify = calls.findIndex((call) => call.key === "verify-post-fix-1-tJRB-012");
  const finalGate = calls.findIndex((call) => call.key === "final-verify");
  const pr = calls.findIndex((call) => call.key === "pr");
  assert.ok(fixMerge >= 0 && fixMerge < postFixReview);
  assert.ok(postFixReview < postFixVerify && postFixVerify < finalGate && finalGate < pr);
  assert.equal(result.fixMerged, true);
  assert.equal(result.finalVerifyPassed, true);
  assert.equal(result.reviews.every((review) => review.verdict === "OK"), true);
  assert.equal(result.prCreated, true);
  const fixImplementer = calls.find((call) => call.key === "fix-review-findings");
  const fixMerger = calls.find((call) => call.key === "merge-review-fixes");
  assert.equal(fixImplementer.gate.command, "npm run test:unit");
  assert.match(fixMerger.gate.command, /\(npm run test:unit\).*printf/);
});

test("implement suppresses a PR when the final full gate fails", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs({
    fullGate: "npm run test:full",
    narrowGate: "npm run test:fast",
  }), { finalGatePass: false });
  assert.equal(result.ok, false);
  assert.equal(result.fullGatePassed, false);
  assert.ok(calls.some((call) => call.key === "final-gate"));
  assert.ok(!calls.some((call) => call.key === "pr"));
});

test("implement does not open a PR when the one post-fix review still blocks", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs(), {
    reviewByKey: {
      "review-initial-standards": "BLOCK",
      "review-post-fix-standards": "BLOCK",
    },
  });
  assert.equal(result.ok, false);
  assert.ok(calls.some((call) => call.key === "review-post-fix-standards"));
  assert.ok(!calls.some((call) => call.key === "final-gate"));
  assert.ok(!calls.some((call) => call.key === "pr"));
});

test("implement-spec does not open a PR when the post-fix review still blocks", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), {
    reviewByKey: {
      "review-initial-standards-1": "BLOCK",
      "review-post-fix-standards-1": "BLOCK",
    },
  });
  assert.equal(result.prCreated, false);
  assert.ok(calls.some((call) => call.key === "review-post-fix-standards-1"));
  assert.ok(!calls.some((call) => call.key === "final-verify"));
  assert.ok(!calls.some((call) => call.key === "pr"));
});

test("implement-spec can opt selected tickets into full intermediate gates", async () => {
  const { calls } = await executeWorkflow("implement-spec", specArgs(oneTicket, {
    fullGateTickets: ["JRB-012"],
  }));
  const implementer = calls.find((call) => call.label.startsWith("Implement ticket"));
  const merger = calls.find((call) => call.label.startsWith("Merge ticket"));
  assert.equal(implementer.gate.command, "npm test");
  assert.match(merger.gate.command, /\(npm test\).*printf/);
});

test("both workflows tell agents to record evidence and check adjacent consumers", async () => {
  const single = await executeWorkflow("implement", singleArgs());
  const implementer = single.calls.find((call) => call.key.startsWith("impl-"));
  const verifier = single.calls.find((call) => call.key === "verify");
  const reviewer = single.calls.find((call) => call.key.startsWith("review-initial-quality"));
  assert.match(implementer.task, /### Implementation/);
  assert.match(verifier.task, /### Independent Verification/);
  assert.match(reviewer.task, /other callers and rendering modes/);

  const spec = await executeWorkflow("implement-spec", specArgs(oneTicket));
  const specImplementer = spec.calls.find((call) => call.label.startsWith("Implement ticket"));
  const specVerifier = spec.calls.find((call) => call.label.startsWith("Verify ticket"));
  const specReviewer = spec.calls.find((call) => call.key.startsWith("review-initial-quality"));
  assert.match(specImplementer.task, /### Implementation/);
  assert.match(specVerifier.task, /### Independent Verification/);
  assert.match(specReviewer.task, /cross-ticket interactions/);
});

test("implement-spec aborts on a dirty checkout before any worktree child", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), { dirtyTree: true });
  assert.equal(result.ok, false);
  assert.equal(result.dirtyTree, true);
  assert.match(result.error, /DIRTY_TREE/);
  assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
  assert.ok(!calls.some((call) => /^fix-\d+-t/.test(call.key)));
  assert.ok(!calls.some((call) => call.key === "ensure-integration-branch"));
});

test("implement-spec skips the clean-tree preflight in finalize mode", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket, {
    finalizeMergedPR: true,
    prUrl: "https://example.test/pull/42",
  }));
  assert.equal(result.ok, true);
  assert.ok(!calls.some((call) => call.key === "preflight-clean-tree"));
});

test("implement-spec transitions use the 180s budget and carry the evidence firewall", async () => {
  const { calls } = await executeWorkflow("implement-spec", specArgs(oneTicket));
  const transitionTasks = calls.filter((call) => call.key.startsWith("transition-"));
  assert.ok(transitionTasks.length > 0);
  assert.ok(transitionTasks.every((call) => call.timeoutMs === 180000));
  assert.ok(transitionTasks.every((call) => /Record nothing anywhere/.test(call.task)));
  assert.ok(transitionTasks.every((call) => /Agent Execution Evidence/.test(call.task)));
});

test("implement-spec escalates a ticket immediately on an identical failure signature", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket, { maxParallel: 1, maxWaves: 1 }), {
    implFail: "worktree admission failed: dirty checkout",
    fixFail: "worktree admission failed: dirty checkout",
  });
  assert.equal(result.ok, false);
  assert.ok(result.escalated.includes("JRB-012"));
  const fixers = calls.filter((call) => /^fix-\d+-t/.test(call.key));
  assert.equal(fixers.length, 1);
});

test("both workflows record evidence with reconcile-never-append semantics", async () => {
  const single = await executeWorkflow("implement", singleArgs());
  assert.match(single.calls.find((call) => call.key.startsWith("impl-")).task, /Reconcile, never append/);
  assert.match(single.calls.find((call) => call.key === "verify").task, /CORRECT stale or contradictory/);
  const spec = await executeWorkflow("implement-spec", specArgs(oneTicket));
  assert.match(spec.calls.find((call) => call.label.startsWith("Implement ticket")).task, /Reconcile, never append/);
  assert.match(spec.calls.find((call) => call.label.startsWith("Verify ticket")).task, /CORRECT stale or contradictory/);
});

// ---------------------------------------------------------------------------
// Contract tests: the orchestrator decides pass/fail from host gates and
// structured output, never from scanning child prose (JRB-016/JRB-017).
// ---------------------------------------------------------------------------

const SOURCES = {
  implement: await readFile(new URL("../skills/engineering/implement/orchestrate.js", import.meta.url), "utf8"),
  "implement-spec": await readFile(new URL("../skills/engineering/implement-spec/orchestrate.js", import.meta.url), "utf8"),
};

for (const [skill, source] of Object.entries(SOURCES)) {
  test(`${skill} never decides outcomes by scanning child prose for tokens`, async () => {
    // Verdict tokens must appear only inside structured-output schema enums,
    // never as indexOf/regex scans over child output.
    assert.doesNotMatch(source, /indexOf\("(?:Review verdict|Verification verdict|MERGE_EFFECTIVE|MERGE_MISSING|CLEAN_TREE|DIRTY_TREE|GROOM_NEEDED|GROOMED_OK|BRANCH_EXISTS|BRANCH_CREATED|MERGED_CONFIRMED|NO_PR_SURFACE)"/);
    assert.doesNotMatch(source, /\/Review verdict|\/Verification verdict|\/MERGE_EFFECTIVE|\/FLAKE_CONFIRMED_TRANSIENT/);
    assert.doesNotMatch(source, /PR_CREATED:\\s\*\(/);
    assert.doesNotMatch(source, /match\(\/WORKTREE_PATH/);
    assert.doesNotMatch(source, /test\(String\((?:r && r\.)?output \|\| ""\)\) && \/TRANSITION_APPLIED/);
  });

  test(`${skill} never passes acceptanceRole as a run param (it is agent config only)`, async () => {
    assert.ok(!source.includes('acceptanceRole:'));
  });

  test(`${skill} declares the shared structured-verdict schemas`, async () => {
    for (const name of [
      "REVIEW_OUTPUT_SCHEMA",
      "VERIFY_OUTPUT_SCHEMA",
      "PR_OUTPUT_SCHEMA",
      "TRANSITION_OUTPUT_SCHEMA",
      "CONFIRM_MERGE_OUTPUT_SCHEMA",
    ]) {
      assert.ok(source.includes(`const ${name} =`), `${name} missing from ${skill}`);
    }
  });
}

test("both workflows give verdict-bearing children an outputSchema", async () => {
  const single = await executeWorkflow("implement", singleArgs());
  const reviews = single.calls.filter((call) => call.key.startsWith("review-"));
  assert.ok(reviews.length > 0);
  assert.ok(reviews.every((call) => call.outputSchema?.properties?.verdict?.enum?.join(",") === "OK,BLOCK,MISSING_TARGET"));
  assert.equal(single.calls.find((call) => call.key === "verify").outputSchema.properties.verdict.enum.join(","), "OK,UNMET");
  assert.equal(single.calls.find((call) => call.key === "pr").outputSchema.required.join(","), "noPrSurface");
  const transitions = single.calls.filter((call) => call.key.startsWith("transition-"));
  assert.ok(transitions.every((call) => call.outputSchema?.properties?.outcome?.enum?.includes("TRANSITION_APPLIED")));
  const groom = single.calls.find((call) => call.key.startsWith("groom-check-"));
  assert.equal(groom.outputSchema.properties.groomed.type, "boolean");

  const spec = await executeWorkflow("implement-spec", specArgs(oneTicket));
  const specReviews = spec.calls.filter((call) => call.key.startsWith("review-"));
  assert.ok(specReviews.every((call) => call.outputSchema?.properties?.verdict?.enum?.join(",") === "OK,BLOCK,MISSING_TARGET"));
  assert.ok(spec.calls.some((call) => call.label.startsWith("Verify ticket") && call.outputSchema?.properties?.verdict));
  assert.equal(spec.calls.find((call) => call.key === "pr").outputSchema.properties.verdict, undefined);
});

test("both workflows decide merger and final-gate success without acceptance reports", async () => {
  const single = await executeWorkflow("implement", singleArgs());
  const gateDecided = single.calls.filter((call) =>
    call.agent === "merger" || call.key === "preflight-clean-tree" || call.key === "ensure-integration-branch");
  assert.ok(gateDecided.length > 0);
  assert.ok(gateDecided.every((call) => call.acceptance === false));
  assert.ok(single.calls.find((call) => call.key === "final-gate").acceptance === false);
  // Implementers keep the harness's default acceptance: they own a real
  // acceptance report, and their gate + report together decide success.
  assert.equal(single.calls.find((call) => call.key.startsWith("impl-")).acceptance, undefined);

  const spec = await executeWorkflow("implement-spec", specArgs(oneTicket));
  const specGateDecided = spec.calls.filter((call) =>
    call.agent === "merger" || call.key === "preflight-clean-tree" || call.key === "ensure-integration-branch");
  assert.ok(specGateDecided.length > 0);
  assert.ok(specGateDecided.every((call) => call.acceptance === false));
  assert.ok(spec.calls.find((call) => call.key === "final-verify").acceptance === false);
});

test("merger idempotency is content-based, not trailer-based", async () => {
  const single = await executeWorkflow("implement", singleArgs());
  const merge = single.calls.find((call) => call.key.startsWith("merge-"));
  assert.match(merge.task, /git apply --check --reverse/);
  // The old idempotency decision grepped commit bodies for the ticket
  // trailer; that check must be gone (the post-commit trailer VALIDATION in
  // step 5 legitimately keeps its grep).
  assert.ok(!merge.task.includes("git log --format=%B"));
  assert.match(merge.task, /JRB-017/);

  const spec = await executeWorkflow("implement-spec", specArgs(oneTicket));
  const specMerge = spec.calls.find((call) => call.label.startsWith("Merge ticket"));
  assert.match(specMerge.task, /git apply --check --reverse/);
  assert.match(specMerge.task, /check out feature\/jrb-001-integration/);
  assert.ok(!specMerge.task.includes("git log --format=%B"));
});

test("clean-tree and branch preflights are decided by host gates, not child prose", async () => {
  const single = await executeWorkflow("implement", singleArgs());
  const preflight = single.calls.find((call) => call.key === "preflight-clean-tree");
  assert.match(preflight.gate.command, /status --porcelain/);
  const ensure = single.calls.find((call) => call.key === "ensure-integration-branch");
  assert.match(ensure.gate.command, /rev-parse --verify 'refs\/heads\/feature\/JRB-012-modal-dismissal'/);

  const spec = await executeWorkflow("implement-spec", specArgs(oneTicket));
  const specPreflight = spec.calls.find((call) => call.key === "preflight-clean-tree");
  assert.match(specPreflight.gate.command, /status --porcelain/);
});

test("implement-spec verifies a failed fix-merge against git state with a valid run key", async () => {
  // Regression: the verify-fix-merge run key used keyOf(ticket.ref) with
  // ticket undefined at that scope, throwing a ReferenceError mid-run.
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), {
    reviewVerdict: "BLOCK",
    fixMergeFail: true,
  });
  const gmVerify = calls.find((call) => call.key.startsWith("verify-fix-merge-"));
  assert.ok(gmVerify, "verify-fix-merge child should run when the fix merger fails");
  assert.ok(!gmVerify.key.includes("undefined"));
  assert.equal(gmVerify.gate.output, "json");
  assert.equal(gmVerify.agentContract.version, 1);
  assert.equal(gmVerify.acceptance, false);
  assert.equal(result.fixMerged, true);
  const specFixMergeTask = calls.find((call) => call.key === "merge-review-fixes");
  assert.match(specFixMergeTask.task, /git apply --check --reverse/);
  assert.ok(!specFixMergeTask.task.includes("git log --format=%B"));
});

test("implement-spec reads the continue-child's worktree from structured output", async () => {
  const { calls } = await executeWorkflow("implement-spec", specArgs(oneTicket), {
    implFail: "child timed out after deadline",
  });
  const continueChild = calls.find((call) => call.key.startsWith("continue-"));
  assert.ok(continueChild, "a timed-out implementer should fall through to the continue-child");
  assert.equal(continueChild.outputSchema.properties.worktreePath.type, "string");
  assert.ok(!continueChild.task.includes("ABSOLUTE LAST LINE"));
});

async function integrationFixture(fn) {
  const repo = await mkdtemp(join(tmpdir(), "workflow-contract-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Workflow Test");
    git("config", "user.email", "workflow@example.test");
    await writeFile(join(repo, "feature.txt"), "old\n");
    git("add", ".");
    git("commit", "-qm", "chore: initial");
    git("checkout", "-qb", "feature/JRB-012-modal-dismissal");
    await writeFile(join(repo, "feature.txt"), "new\n");
    const patch = git("diff");
    git("checkout", "--", "feature.txt");
    const asyncDir = join(repo, "async-subagent-runs", "r-impl");
    await mkdir(join(asyncDir, "worktree-diffs", "step-0"), { recursive: true });
    const patchPath = join(asyncDir, "worktree-diffs", "step-0", "change.patch");
    await writeFile(patchPath, patch);
    // Runtime artifacts live outside the checkout in production. The fixture
    // keeps them here for access; exclude them from git's clean-tree check.
    await writeFile(join(repo, ".gitignore"), "async-subagent-runs/\n");
    git("add", ".gitignore");
    git("commit", "-qm", "chore: ignore runtime artifacts");
    await fn({ repo, git, patchPath, asyncDir });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

test("host clean-tree gate fails closed when the checkout is not a git repository", async () => {
  for (const skill of ["implement", "implement-spec"]) {
    const graph = structuredClone(oneTicket);
    graph.preflight.integrationBranch = "feature/JRB-012-modal-dismissal";
    const { calls } = await executeWorkflow(skill, skill === "implement"
      ? singleArgs({ repoPath: "/not/a/workflow/repo", skipPR: true })
      : specArgs(graph, { repoPath: "/not/a/workflow/repo", skipPR: true }));
    const command = calls.find((call) => call.key === "preflight-clean-tree").gate.command;
    assert.notEqual(spawnSync("sh", ["-c", command]).status, 0, `${skill} incorrectly accepted a missing checkout`);
  }
});

test("a passing test suite cannot accept a merger that never applied the captured patch", async () => {
  await integrationFixture(async ({ repo, git, asyncDir }) => {
    const args = singleArgs({ repoPath: repo, fullGate: "true", narrowGate: "true", skipPR: true });
    const { calls, result } = await executeWorkflow("implement", args, {
      implArtifactPaths: [asyncDir], runHostGates: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, "merge");
    assert.ok(calls.some((call) => call.key.startsWith("merge-")));
    assert.equal(git("show", "HEAD:feature.txt"), "old\n");
  });
});

test("implement-spec merger retries launch under distinct keys after a failed first attempt", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), {
    cacheKeys: new Map(), failFirstMerge: true,
  });
  assert.equal(result.ok, true);
  const merges = calls.filter((call) => call.key.startsWith("merge-"));
  assert.equal(merges.length, 2);
  assert.notEqual(merges[0].key, merges[1].key);
});

test("host postconditions accept only an applied patch on the integration branch", async () => {
  await integrationFixture(async ({ repo, git, patchPath, asyncDir }) => {
    const args = singleArgs({ repoPath: repo, fullGate: "true", narrowGate: "true", skipPR: true });
    const { result } = await executeWorkflow("implement", args, {
      implArtifactPaths: [asyncDir], runHostGates: true,
      mergeAction: () => {
        git("apply", "--index", patchPath);
        git("commit", "-qm", "fix: update fixture\n\nIssue: JRB-012");
      },
    });
    assert.equal(result.ok, true);
    assert.equal(git("show", "HEAD:feature.txt"), "new\n");
  });
});

test("implement-spec refuses a green test command when the merger did not commit", async () => {
  await integrationFixture(async ({ repo, asyncDir }) => {
    const graph = structuredClone(oneTicket);
    graph.preflight.integrationBranch = "feature/JRB-012-modal-dismissal";
    const args = specArgs(graph, { repoPath: repo, integrationBranch: "feature/JRB-012-modal-dismissal", fullGate: "true", narrowGate: "true", skipPR: true });
    const { calls, result } = await executeWorkflow("implement-spec", args, {
      implArtifactPaths: [asyncDir], runHostGates: true,
    });
    assert.equal(result.ok, false);
    assert.equal(calls.filter((call) => call.key.startsWith("merge-")).length, 2);
  });
});

test("a transition's structured success cannot override a failing tracker-state check", async () => {
  await integrationFixture(async ({ repo }) => {
    const { result, calls } = await executeWorkflow("implement", singleArgs({
      repoPath: repo, fullGate: "true", skipPR: true,
      transitionCheckCommands: { in_progress: "false" },
    }), { runHostGates: true });
    assert.equal(result.ok, false);
    assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
  });
});

test("a child-reported PR URL requires an independent host lookup", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs({ prCheckCommand: "false" }), {
    runHostGates: true, gateFilter: (call) => call.key === "confirm-pr",
  });
  assert.equal(result.ok, false);
  assert.equal(result.prFailed, true);
  assert.ok(calls.some((call) => call.key === "confirm-pr"));
});

test("post-merge completion requires a host check of the merge reference", async () => {
  const { calls, result } = await executeWorkflow("implement", singleArgs({
    finalizeMergedPR: true, prUrl: "https://example.test/pull/42", mergeCheckCommand: "false",
  }), { runHostGates: true, gateFilter: (call) => call.key.startsWith("check-merge") });
  assert.equal(result.ok, false);
  assert.ok(!calls.some((call) => call.key.includes("transition-complete")));
});

test("implement-spec does not complete issues when host merge confirmation fails", async () => {
  const { result, calls } = await executeWorkflow("implement-spec", specArgs(oneTicket, {
    finalizeMergedPR: true, prUrl: "https://example.test/pull/42", mergeCheckCommand: "false",
  }), { runHostGates: true, gateFilter: (call) => call.key === "check-merge" });
  assert.equal(result.finalized, false);
  assert.ok(!calls.some((call) => call.key.includes("transition-complete")));
});

test("implement-spec rejects an incomplete ticket graph rather than implementing a subset", async () => {
  const graph = structuredClone(oneTicket);
  graph.tickets.push({ ref: "JRB-013", title: "second ticket", resolved: false, blockedBy: [], groomed: true });
  const partial = JSON.stringify(graph).slice(0, -65);
  const { result, calls } = await executeWorkflow("implement-spec", specArgs(graph), {
    graphOutput: partial,
  });
  assert.equal(result.ok, false);
  assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
});

test("successful child execution without typed host proof never passes preflight", async () => {
  for (const skill of ["implement", "implement-spec"]) {
    const { calls, result } = await executeWorkflow(skill,
      skill === "implement" ? singleArgs() : specArgs(oneTicket), {
        missingHostProof: (call) => call.key === "preflight-clean-tree",
      });
    assert.equal(result.ok, false);
    assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
  }
});

test("a failed implementer does not relaunch successful siblings under cached keys", async () => {
  const graph = structuredClone(oneTicket);
  graph.tickets.push({ ref: "JRB-013", title: "Independent", resolved: false, blockedBy: [], onBranch: false, groomed: true });
  const { calls } = await executeWorkflow("implement-spec", specArgs(graph, { maxParallel: 2 }), {
    cacheKeys: new Map(), implFailByKey: { "impl-1-tJRB-012": "provider unavailable" },
  });
  for (const ref of ["JRB-012", "JRB-013"]) {
    assert.equal(calls.filter((call) => call.key === `impl-1-t${ref}`).length, 1);
  }
});

test("both workflows reject missing state-check configuration before launching children", async () => {
  for (const skill of ["implement", "implement-spec"]) {
    const args = skill === "implement"
      ? singleArgs({ transitionCheckCommands: {} })
      : specArgs(oneTicket, { transitionCheckCommands: {} });
    const { result, calls } = await executeWorkflow(skill, args);
    assert.equal(result.configError, true);
    assert.equal(result.ok, false);
    assert.match(result.error, /transitionCheckCommands.in_progress/);
    assert.equal(calls.length, 0);
  }
});

test("implement-spec rejects a false tracker-state claim before starting a worktree", async () => {
  await integrationFixture(async ({ repo }) => {
    const graph = structuredClone(oneTicket);
    graph.preflight.integrationBranch = "feature/JRB-012-modal-dismissal";
    const { result, calls } = await executeWorkflow("implement-spec", specArgs(graph, {
      repoPath: repo, integrationBranch: "feature/JRB-012-modal-dismissal", fullGate: "true",
      transitionCheckCommands: { in_progress: "false" }, skipPR: true,
    }), { runHostGates: true });
    assert.equal(result.ok, false);
    assert.ok(!calls.some((call) => call.key.startsWith("impl-")));
  });
});

test("implement-spec confirms the captured patch and issue trailer on the host", async () => {
  await integrationFixture(async ({ repo, git, patchPath, asyncDir }) => {
    const graph = structuredClone(oneTicket);
    graph.preflight.integrationBranch = "feature/JRB-012-modal-dismissal";
    const args = specArgs(graph, { repoPath: repo, integrationBranch: "feature/JRB-012-modal-dismissal", fullGate: "true", narrowGate: "true", skipPR: true });
    const { result } = await executeWorkflow("implement-spec", args, {
      implArtifactPaths: [asyncDir], runHostGates: true,
      mergeAction: () => {
        git("apply", "--index", patchPath);
        git("commit", "-qm", "fix: update fixture\n\nIssue: JRB-012");
      },
    });
    assert.equal(result.ok, true);
    assert.equal(git("show", "HEAD:feature.txt"), "new\n");
  });
});

test("gate-only children use host-owned typed proof rather than a child acceptance report", async () => {
  const single = await executeWorkflow("implement", singleArgs());
  const spec = await executeWorkflow("implement-spec", specArgs(oneTicket));
  for (const call of [...single.calls, ...spec.calls].filter((step) => step.gate?.output === "json")) {
    assert.equal(call.agentContract?.version, 1, `${call.key} must not require an acceptance report`);
    assert.equal(call.acceptance, false);
    assert.equal(call.outputSchema, undefined, `${call.key} cannot mix a typed gate and child outputSchema`);
    assert.equal(call.gate.schema.properties.verified.const, true);
  }
  for (const calls of [single.calls, spec.calls]) {
    const transition = calls.find((call) => call.key.startsWith("transition-"));
    assert.ok(transition.outputSchema);
    assert.equal(transition.gate, undefined);
    assert.ok(calls.some((call) => call.key.startsWith("check-transition-") && call.gate.output === "json"));
  }
});

test("shared verdict schemas remain identical across both orchestrators", () => {
  for (const name of ["REVIEW", "VERIFY", "PR", "TRANSITION", "CONFIRM_MERGE"]) {
    const re = new RegExp(`const ${name}_OUTPUT_SCHEMA = [\\s\\S]*?\\n};`);
    const single = SOURCES.implement.match(re)?.[0];
    const spec = SOURCES["implement-spec"].match(re)?.[0];
    assert.ok(single && spec, `${name} is missing`);
    assert.equal(spec, single, `${name} drifted across workflows`);
  }
});

test("a PR surface claimed absent by a worker needs advance authorization", async () => {
  for (const skill of ["implement", "implement-spec"]) {
    const args = skill === "implement" ? singleArgs() : specArgs(oneTicket);
    const { result } = await executeWorkflow(skill, args, { noPrSurface: true });
    assert.equal(result.ok, false);
    assert.equal(result.prFailed, true);
  }
});
