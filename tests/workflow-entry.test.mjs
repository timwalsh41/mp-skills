import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
      return Promise.resolve(responseFor(call, { ...options, ticketGraph: args.ticketGraph }));
    },
    all(promises) {
      return Promise.all(promises);
    },
  };
  const execute = new AsyncFunction("args", "runs", "emit", source);
  const result = await execute(args, runs, () => {});
  return { calls, result };
}

function responseFor(call, options) {
  const { key, label = "", task = "" } = call;
  if (key === "ensure-integration-branch") return { ok: true, output: "BRANCH_EXISTS" };
  if (key.startsWith("groom-check-")) {
    return { ok: true, output: options.groomed === false ? "GROOM_NEEDED" : "GROOMED_OK" };
  }
  if (key === "ticket-graph-forced" || key === "ticket-graph") {
    return { ok: true, output: JSON.stringify(options.ticketGraph) };
  }
  if (key === "confirm-merge" || key.startsWith("verify-merge-") || key.startsWith("confirm-merge-")) {
    return { ok: true, output: options.mergeConfirmed === false ? "MERGE_NOT_CONFIRMED" : "MERGED_CONFIRMED" };
  }
  if (key.startsWith("transition-")) {
    const phase = key.split("-")[1];
    return options.transitionFailPhase === phase
      ? { ok: true, output: "TRANSITION_FAILED: simulated" }
      : { ok: true, output: "TRANSITION_APPLIED" };
  }
  if (key === "fix-review-findings") {
    return options.reviewFixPass === false
      ? { ok: false, error: "review fix did not pass", output: "failed" }
      : { ok: true, output: "review fixes ready" };
  }
  if (key === "final-verify") {
    return options.finalVerifyPass === false
      ? { ok: false, error: "full suite failed", output: "FAILED" }
      : { ok: true, output: "full suite passed" };
  }
  if (key.startsWith("review-")) {
    return { ok: true, output: "Review verdict: " + (options.reviewVerdict || "OK") + "\nFinding: simulated review finding" };
  }
  if (key === "pr") {
    if (options.prFail) return { ok: false, error: "request creation failed", output: "PR_FAILED" };
    return { ok: true, output: options.noPrSurface ? "NO_PR_SURFACE" : "PR_CREATED: https://example.test/pull/42" };
  }
  if (key.startsWith("cleanup")) return { ok: true, output: "WORKTREES_CLEANED" };
  if (label.startsWith("Validate ticket ")) {
    return { ok: true, output: options.groomed === false ? "GROOM_NEEDED" : "GROOMED_OK" };
  }
  if (label.startsWith("Implement ticket ") || label.startsWith("Implement JRB-")) {
    return { ok: true, output: "implementation complete" };
  }
  if (label.startsWith("Merge ticket ") || label.startsWith("merge-")) {
    return { ok: true, output: "merge complete" };
  }
  if (label.startsWith("Verify JRB-") || key.startsWith("verify-")) {
    return { ok: true, output: "Verification verdict: OK" };
  }
  if (label.startsWith("Transition ")) {
    return { ok: true, output: task.includes("MERGE_NOT_CONFIRMED") ? "MERGE_NOT_CONFIRMED" : "TRANSITION_APPLIED" };
  }
  return { ok: true, output: "ok" };
}

function singleArgs(overrides = {}) {
  return {
    ticketRef: "JRB-012",
    gate: "npm test",
    integrationBranch: "feature/JRB-012-modal-dismissal",
    baseBranch: "main",
    repoPath: "/repo",
    trackerHint: "Read docs/agents/issue-tracker.md for issue operations.",
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
  const { calls, result } = await executeWorkflow("implement", singleArgs(), { noPrSurface: true });
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

test("implement-spec suppresses PR when final verification fails, even with a waiver", async () => {
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket, { prWaiverReason: "Allow review gap only." }), { finalVerifyPass: false });
  assert.equal(result.prCreated, false);
  assert.ok(!calls.some((call) => call.key === "pr"));
  const finalVerify = calls.find((call) => call.key === "final-verify");
  assert.match(finalVerify.task, /Conventional Commit/);
  assert.match(finalVerify.task, /Issue: <ref>/);
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
  const { calls, result } = await executeWorkflow("implement-spec", specArgs(oneTicket), { noPrSurface: true });
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
