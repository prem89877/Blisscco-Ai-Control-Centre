# Agent 2 - Development & GitHub Agent (Phase 2 / Part 2)

## Integration (from Phase 1 + Agent 1 inspection)
- Reuses Phase 1 tables as-is: `agents` (slot 2), `tasks`, `approvals`, `activity_logs`, `api_usage`. **No SQL migration.**
- Same pattern as Agent 1: `agent2/*.ts` -> `agent2/dist`, Vercel function `/api/agent2` (3rd of 12 Hobby slots), Termux CLI, same auth (Supabase JWT + `ai_control.owners`).
- Agent 1 is **untouched** (its own tests still pass). Agent 2 has its own copies of util/store, its own Gemini key (`AGENT2_GEMINI_API_KEY`) and own GitHub token.
- Dashboard: Agents tab -> slot 2 console. Approvals tab works unchanged. Tasks, Logs, API Usage fill automatically.
- Not built: Orchestrator, automatic workflows, Agent 3.

## Two places it runs
| Where | What | Why |
|---|---|---|
| Vercel `/api/agent2` + dashboard | inspect repo, submit code, AI bug fix, create branch + commit (GitHub API), monitor Actions, promote (PR + merge), rollback | Vercel cannot run git/npm |
| Termux CLI | inspect, edit files, branch, lint / type check / tests, approved commands, commit, push | needs a real device shell |

## Workflow (your 9 steps)
1. Receive code: dashboard "Submit code" (JSON) or `local-apply --file=change.json`, or "Fix a bug with AI".
2. Inspect existing files: `repo_inspect`, `local-inspect` (also done automatically before every change).
3-4. Separate branch `agent2/<title>-<time>`. Nothing is written to GitHub until approved.
5. Checks: `checks` runs lint, type check, tests, build (only scripts that exist; says so if none).
6. Summary: changed files (+/-), warnings, Gemini review, diff.
7-8. Approval -> push/commit. Promotion to production is a separate approval.
9. Report: commit SHA, compare URL, GitHub Actions runs, Vercel deployment trigger, rollback instruction.

## Safety model
| Rule | Enforced by |
|---|---|
| Never push to production without approval | Agent only writes `agent2/*` branches. `main/master/production/prod/release*` are blocked in 3 layers (planner, API client, git push). Production only via PR merge: approval + `APPROVE-PRODUCTION` tick + green CI + sha-pinned merge |
| Never delete/overwrite unrelated files | `create` fails if file exists, `update`/`delete` fail if missing; local apply refuses a dirty working tree; commit stages only the change-set files; rollback restores only those files and refuses if newer edits exist |
| Never expose secrets | Secret scan blocks code containing keys (rule + line only, value never shown). Secret files (`.env*`, keys, `.npmrc`) unreadable/unwritable. Responses, DB rows, logs redacted. Token reaches git only in the child's environment (not argv, not remote URL). Commands run with a scrubbed environment |
| No blind shell commands | No shell is ever used (argv array). Metacharacters, quotes, globs rejected. Safe read-only commands run; unknown/risky ones wait for approval of the exact command (hash-checked); dangerous ones (sudo, push, env, rm -rf, curl-pipe, config...) are always blocked |
| Rollback | Every change has a record. Local: `local-rollback`. GitHub: delete branch, or revert PR (restores only touched files, refuses on conflict). Base branch is never modified until a promotion |
| Approvals | Must be approved, <24h old, executed once (atomic claim), content hash verified, failures release the claim and clean half-made branches |
| Sensitive files (`.github/`, `package.json`, `vercel.json`, `supabase/`, `*.sql`, `agent*/`) | Extra confirmation tick; changed `package.json` scripts need `--ack=RUN-CHANGED-SCRIPTS` before checks run |
| Gemini | Own key, no tools, input treated as data, may only change files you selected, output goes through the same validation and approval. Usage logged to `api_usage` |

## Evidence (`npm test`: Agent 1 + Agent 2, 0 failures; TypeScript compiles clean)
Agent 2: **27 tests**, against an in-memory fake of Supabase, GitHub (git data API, PRs, merge, Actions, deployments) and Gemini, plus **real git and real processes** in a temp repo with a local bare remote:
- Auth 401/403/405/500/400; local actions unreachable from Vercel.
- Propose writes nothing to GitHub; no file content stored in the approval; overwrite/missing/secret/secret-file/unknown-repo all refused.
- Apply: blocked before approval, after expiry, on tampered content; sensitive ack; creates branch + 1 commit from the approved base; unrelated files byte-identical; main unchanged; every ref write is `agent2/*`; second apply refused; mid-way failure removes the half-made branch and allows a clean retry.
- Protected branches rejected by the GitHub client itself (create/commit/delete).
- Promote: production tick, CI running/failed, branch moved after approval, sha-pinned merge, once only.
- Rollback: branch delete guarded against new commits; revert PR restores only touched files, refuses when someone edited them since; main untouched.
- Shell policy matrix (safe / approval / blocked / injection attempts), approved command hash tamper refused, secrets absent from child environment.
- Local: dirty tree refused, only listed files written, checks pass/fail reported correctly, package.json change needs ack, blocked commit leaves nothing staged, stray file not committed, secret in staged diff blocked, changed-after-approval push refused, real push reaches only the agent branch (remote main unchanged), rollback restores base and deletes only the agent branch.
- Secret scan: none of the 3 keys appear in any response, DB row or log; bad GitHub token -> task failed, agent `error`, token not echoed.
- Dashboard files parse (esbuild); `package.json` / `vercel.json` valid.

## Not verified (no internet in build sandbox)
- Live calls to GitHub and Gemini (endpoints per current docs; Gemini model name `gemini-3.5-flash` copied from Agent 1).
- `vite build` and on-device run: do `npm install && npm test && npm run build` in Termux.
- Real `git push` to github.com (tested against a local bare remote with the same command and a URL rewrite).
- Fine-grained token permissions: if GitHub answers 403 the error says to check them.

## Setup (once)
1. Google AI Studio: new project, new key -> `AGENT2_GEMINI_API_KEY`.
2. GitHub fine-grained token, only your repo: Contents RW, Pull requests RW, Actions read, Deployments read, Metadata read -> `AGENT2_GITHUB_TOKEN`; `AGENT2_GITHUB_REPOS=you/repo`.
3. Vercel env vars: the 3 above. Termux: same in `.env.agent2`, plus `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, `AGENT2_WORKDIR=/path/to/repo`.
4. `npm install && npm test && npm run build`, push, open Agents -> slot 2.
