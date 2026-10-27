// Single-child wrapper so the final review-fix implementer gets managed
// worktree isolation (single-child spawns don't isolate by default).
//
// args: {
//   task:      string (required) — what to fix
//   gate:      string (required) — this repo's verification command, from
//              docs/agents/verification.md
//   agent?:    string — role name, default "implementer"
//   baseRef?:  string — named ref the worktree branches from, e.g.
//              "refs/heads/<integrationBranch>". Omit to branch from HEAD.
//   gateTimeoutMs?: number — default 15 min; harness gate caps are shorter
//              than most real suites, so this is explicit, not inherited.
// }
const gate = args && args.gate;
if (!gate || !args.task) {
  return {
    ok: false,
    error: "run-fix-pass needs args.task and args.gate (the repo's verification command; see docs/agents/verification.md)"
  };
}

const opts = {
  label: "Fix remaining review findings (worktree-isolated)",
  agent: args.agent || "implementer",
  task: args.task,
  worktree: true,
  timeoutMs: args.timeoutMs || 75 * 60 * 1000,
  gate: { command: gate, timeoutMs: args.gateTimeoutMs || 15 * 60 * 1000 }
};
if (args.baseRef) opts.baseRef = args.baseRef;

const result = await runs.run("final-review-fix", opts);
return {
  ok: !!(result && result.ok),
  runId: result && result.runId,
  worktree: true,
  output: result && result.output ? result.output.slice(0, 4000) : null,
  artifactPaths: result && result.artifactPaths
};
