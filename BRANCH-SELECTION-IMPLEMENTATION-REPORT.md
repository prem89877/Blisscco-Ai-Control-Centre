# Dynamic GitHub Branch Selection - Implementation Report (verified revision)

## Test results (actually run)
- `tsc` for agent1, agent2, agent3, orchestrator: clean.
- Full suite (agent1 + agent2 + agent3 + orchestrator + src): **246 tests, 246 pass, 0 fail** (baseline before work: 209/209).
- All GitHub traffic in tests is mocked; no production writes.
- NOT run: `vite build` and in-browser UI testing (React/Vite not installed in the verification environment).

## What was implemented
- `src/BranchSelector.jsx` (repo + branch dropdown, default label, Refresh, loading/error/empty states) and `src/branchContext.js` (shared, tested logic) used by Agent 1, 2, 3.
- Selection remembered per agent + repository (localStorage). A deleted branch is cleared and reported; no other branch is substituted.
- `github_branches` action on all three agents: allow-listed repo check, pagination (100/page), "/" names.
- Only GitHub-related actions carry repo + branch + SHA + `branch_context_required`; the server rejects such calls without a branch (400 `branch_required`), moved branch (409 `base_changed`), deleted branch (404).
- Agent 1: SHA-pinned commits/CI runs/tree for the selected branch; re-checks the ref after the calls.
- Agent 2: inspect, chat, proposal, CI status use selected base pinned to SHA. Proposal/approval/result carry repo, base branch, base SHA, working branch, commit destination, CI target. Base re-verified before claim and apply; moved/deleted base -> 409 and nothing is written. `assertAgentBranch` unchanged. Promote merges into the recorded base branch under a separate approval + production tick.
- Agent 3: branch verified before any run; tree and file reads pinned to its SHA; report/task payload include repo, branch, SHA; retest re-runs on the same branch.

## Fixes to the earlier delivered files
Duplicate object key (build failure); 5 regressions; retest default fallback; swallowed branch errors in Agent 3 full_report and Agent 2 dev_chat; promote target; claim-before-check; over-broad frontend branch requirement.

## Tests added
`agent1/agent1.test.ts`, `agent2/agent2.test.ts`, `agent3/agent3.test.ts` (branch sections), `src/branchContext.test.js`, plus the three `branches.test.ts` files.

## Changed files
src/BranchSelector.jsx, src/branchContext.js (new), src/branchContext.test.js (new), src/Agent1.jsx, Agent2.jsx, Agent3.jsx, agent1/github.ts, agent1/agent.ts, agent2/github.ts, agent2/agent.ts, agent2/dev.ts, agent3/github.ts, agent3/agent.ts, the three agentN test files, three branches.test.ts, package.json, this report.

## Remaining limitations
- Orchestrator unchanged (its ZIP workflow already has base branch + SHA pinning); its summaries do not show the Agent 1/2/3 selector context.
- Server enforcement is active when `branch_context_required` is sent (the UI always does); CLI/legacy callers without it keep default-branch behaviour.
- Agent 3 website/API/DB checks hit the live target, not branch code; only repo scans are branch-specific.
- Agent 1 Vercel data is reported, not branch-filtered; selection does not trigger deployments.
- Selection is per browser/device (localStorage). Pagination capped at 100 pages.
- Frontend build and browser behaviour not verified here.
