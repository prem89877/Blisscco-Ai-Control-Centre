# Agent 2: continue on an existing agent2/* branch (fix)

## Problem
Every Agent 2 proposal created a NEW agent2/* branch from the dropdown base (main). A branch named in the prompt was ignored,
so a follow-up change (e.g. the test file after the config change) landed on a different branch, with no link to the first commit,
and CI failed on each branch alone.

## Fix
- `continue_branch` (optional): the proposal adds ONE commit to that EXISTING agent2/* branch (fast-forward only). No new branch.
- Auto-detect: if the request names exactly one existing agent2/* branch AND says "existing", "naya mat banao", "isi/usi branch", "continue",
  "same branch", "working branch", it continues that branch. Unknown or ambiguous names are errors (404 branch_not_found / 400 branch_ambiguous),
  never a silent new branch.
- The diff and file checks run against the CURRENT tip of that branch (so `update` and `create` are validated against the right files).
- Approval pins that tip (`parent_sha`). If the tip moved or the branch was deleted before Apply: 409 base_changed, nothing written, approval not consumed.
- Unchanged safety: only agent2/* (main/release/* blocked with 403), secret scan, content hash, sensitive ack, dropdown base binding.
- Default behaviour (no continue request) is unchanged: a new agent2/* branch.
- UI: optional input "Continue on existing agent2/* branch"; approval card shows "Adds ONE commit to the existing branch ...".

## Note
"Request rollback" on a continued branch deletes the WHOLE branch (earlier commits too). The Apply result says so.

## Tests
agent2: 82/82 (was 77 + 1; 4 new CONTINUE tests), orchestrator 85/85, src 13/13, tsc clean. GitHub/Supabase/Gemini mocked.
JSX only syntax-checked (esbuild); vite build and browser not run.

## Files changed
agent2/agent.ts, agent2/dev.ts, agent2/agent2.test.ts, src/Agent2.jsx, CONTINUE-BRANCH-FIX-REPORT.md
