# Agent 2 - Professional Developer Upgrade (report)

## What was added (all on top of the existing system; nothing removed)
| Area | Implementation |
|---|---|
| Conversation | `dev_chat`: Hindi/English/Hinglish Q&A, follow-ups (client sends last N turns), reads only files named in the message (redacted, read-only). Decides `answer` / `proposal` / `unsupported` (names Agent 1, Agent 3 or Orchestrator). |
| Explain / Debug / Review / Plan / Docs | `dev_assist` (answer only, writes nothing). |
| Proposal system | `dev_proposal`: inspect -> plan (2 passes, reads extra files it asks for) -> generate code in batches -> self-fix rounds -> static checks -> AI code review -> final report -> existing `propose_change` (approval, branch name, base pin, content hash, secret scan, sensitive flag). No JSON by the owner. |
| CI loop | `dev_diagnose`: reads real GitHub Actions result; on failure explains the root cause from the real job log; `propose_fix` builds a fix proposal on the agent2 branch (needs approval again). |
| Termux loop | `local_iterate` (`npm run agent2 -- iterate`): runs REAL lint/type/test/build, lets the model fix only files of the change set, re-runs, bounded rounds. |
| Limits | 5-file AI-fix cap -> configurable (`AGENT2_DEV_*`, clamped). Proposal cap 40 files (up to 120). Bigger plans are returned unchanged for splitting (never silently cut). |
| Dashboard | Tabs: Ask, Proposal, Build, Explain, Debug, Review, Plan, Pending, Progress, Reports, Tools (old tools kept). Mobile-first, same styles. |
| CLI | New: `chat`, `dev-propose`, `explain`, `diagnose [--propose-fix]`, `iterate`. Old commands unchanged. |

## Honesty rules (enforced in code)
* API/Vercel mode has no shell: only **static checks** run (secret scan, JSON validity, non-empty). The report lists lint, type-check, tests, build as **NOT RUN**.
* "Tests passed" can only come from `local_iterate` (real exit codes) or GitHub Actions (`dev_diagnose`).
* Unsupported work is declined with the responsible agent named. Agent 2 does not do Agent 1 infrastructure or Agent 3 QA.

## Security (unchanged guards, none weakened)
agent2/* branches only; protected branches blocked in every write path; approval + 24h expiry + single execution; content-hash check at apply; sensitive-file / production ticks; secret scan; secret files blocked; files containing secret-like values are never sent to the model for rewrite; model output limited to planned paths (out-of-scope = hard error).

## Tests
`agent2/agent2.test.ts`: 33 old + 21 new = 54 passing (conversation, assist, multi-file, create/modify/delete, batches, self-fix, bad output, security, secrets, split, full flow approval -> branch/commit -> CI -> diagnose -> fix proposal, local_iterate with real processes). Agent 1/3/Orchestrator suites unchanged and re-run in `npm test`.

## Remaining limitations
1. Vercel cannot run lint/tests/build; use Termux `iterate` or GitHub Actions.
2. Rewrites whole files; files > ~60k chars or with secret-like values are refused.
3. No semantic/embedding search: context = file list + named files + model-selected files (max 2 planning passes).
4. Plans over the file cap must be split by the owner.
5. Chat history is kept in the browser/CLI call, not stored server-side.
6. Quality depends on Gemini; the review is advisory. Owner approval is the gate.
7. Not verified against live Gemini/GitHub (tests use fakes like the existing suite).
