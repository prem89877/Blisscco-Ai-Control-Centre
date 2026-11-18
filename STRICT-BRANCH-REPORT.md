# Strict GitHub Branch Selection - Report

Tests: tsc clean (agent1/2/3/orchestrator); 267/267 pass (baseline 246). All GitHub/Supabase/Gemini mocked. Frontend only syntax-checked (esbuild); vite build / browser not run.

## Made strict
- Dashboard requests (branch_context_required or selected_branch) never fall back to default_branch: missing -> 400 branch_required, other branch than dropdown -> 409 branch_override, moved SHA -> 409 base_changed, deleted -> 404 branch_not_found.
- Agent 2: repoInspect, actionsStatus, proposeChange, aiFix (SHA pin now forwarded), requestWorkflow, requestPromote, rollback, dev_* ; ai_command injects the selected base (model may only name an existing agent2/* branch that the owner's text also names); apply_* refuse a selection that differs from the approval's recorded base (409 base_mismatch). Results carry `scope` (Base / Working / Commit destination / CI target).
- Agent 1: inspect(strict), repo_required guard, ai_command GitHub intents need the selection.
- Agent 3: tree()/file() require a ref; scan re-checks the branch did not move; ai_command, Termux queue + worker and retest carry/require branch+SHA.
- Frontend: complete GITHUB_ACTIONS, soft actions, no override from Tools; Agent 2 Tools branch field and per-card repo pickers removed; Base vs Working block; repo@branch@sha in Agent 1/2/3 headers.

## Files changed
agent1/agent.ts, agent1/github.ts, agent1/agent1.test.ts, agent2/agent.ts, agent2/dev.ts, agent2/agent2.test.ts, agent3/agent.ts, agent3/github.ts, agent3/worker.ts, agent3/agent3.test.ts, src/branchContext.js, src/branchContext.test.js, src/BranchSelector.jsx, src/Agent1.jsx, src/Agent2.jsx, src/Agent3.jsx, STRICT-BRANCH-REPORT.md

## Intentionally NOT branch-scoped
Vercel live reporting (Agent 1); Agent 3 live website/API/DB checks; Orchestrator ZIP workflow (own base+SHA pin, unchanged); Agent 2 working-branch design (commits only to new agent2/*). Legacy CLI callers without the flags keep the documented default-branch behaviour.

## Note
Apply on the dashboard needs the dropdown on the approval's base branch (else 409 base_mismatch).
