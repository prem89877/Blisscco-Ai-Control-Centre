# Phase 3 Part 2 — Deployment Control Center (ZIP workflow) — Report

Extends the existing Orchestrator. Phase 3 Part 1 behaviour, Agent 1/2/3 code paths and all their safeguards are unchanged
except where listed under "Files". Agent 3 is not imported, called or triggered anywhere.

## 1. Files

| File | Change |
|---|---|
| `orchestrator/zip.ts` | **new** – server-side ZIP parser/validator |
| `orchestrator/workflow.ts` | modified – `upload_zip`, SQL stages (`awaiting_sql`, `applying_sql`), `apply_sql`, combined report |
| `orchestrator/orchestrator.test.ts` | modified – mock extended (Gemini bodies, SQL execution) + 17 new ZIP/SQL tests |
| `orchestrator/zip.test.ts` | **new** – parser unit tests |
| `agent2/agent.ts` | modified – `proposeChange`: compact priority-ordered digest, `expected_base_sha` pin, `ai_usage` in result/approval |
| `agent2/gemini.ts` | modified – `review()` bounding (14,000 chars in / 1,200 tokens out), real `partial` flag |
| `src/Orchestrator.jsx` | modified – ZIP upload, file list, diff preview, Gemini/token panel, SQL approval + run, history, report |
| `README.md`, `16-PHASE3-PART2-REPORT.md` | docs |

## 2. ZIP extraction and validation (`orchestrator/zip.ts`, `uploadZipWorkflow`)

* Base64 upload, decoded and parsed **only on the server** (own central-directory parser + `zlib.inflateRawSync` with `maxOutputLength`); nothing is written to disk or to any public storage.
* Limits: 2 MB archive, 40 entries, 200 KB per file, 600 KB total extracted, 100:1 compression ratio.
* Rejected: absolute paths, `../`, backslashes, `.git`/`node_modules`, secret-file names (`.env`, `*.pem`…), symlinks, duplicate paths (case-insensitive), encrypted entries, unsupported compression, CRC/size mismatch, binary/non-UTF-8 files, unsupported extensions, any secret found by the Agent 2 secret scanner (whole ZIP refused).
* `__MACOSX/`, `.DS_Store`, `Thumbs.db` are skipped and listed as ignored. Archives with data-descriptor flags (macOS/Android tools) are accepted.
* SHA-256 of the ZIP and of every file is stored.
* Target repo must be in `AGENT2_GITHUB_REPOS`. The base branch head SHA is read from GitHub, optionally pinned by the owner (`expected_base_sha`), and passed to Agent 2, which refuses (409 `base_changed`) if the branch moved before the proposal is built. Create/update is detected against that base tree. Deletions use `.blisscco-delete.txt` and must exist in the base.
* Duplicate protection: same `request_id` → 409; same ZIP checksum for the same repo → 409 `duplicate_zip`.
* Nothing is written to GitHub at upload or preview.

## 3/4. Gemini token optimisation

Gemini never receives the ZIP, unchanged files, full file bodies, SQL or secrets. Agent 2 builds a compact digest:
title/description/base, total files/added/removed/bytes, and per file: path, operation, file type, +/- line counts, a bounded diff hunk (≤1,500 chars, ≤40 lines per side), short description, security findings.

* **Maximum input: 14,000 serialized characters. Maximum output: 1,200 tokens.** (`REVIEW_MAX_INPUT_CHARS`, `REVIEW_MAX_OUTPUT_TOKENS`)
* Files are sorted by priority (sensitive → deletes → build/config/CI files → by change size). When over budget, the hunk of the **lowest-priority file is halved repeatedly** first; whole files are dropped only after every hunk is empty; a last resort sends title/description only.
* Truncation sets `partial = true`: the Agent 2 proposal gets a warning and the dashboard shows "PARTIAL".
* Tokens in/out, model and estimated cost are written through the existing `recordAi` → `api_usage` row (`propose_change_review`) and shown in the dashboard.
* The AI Fix workflow keeps its own path; it only benefits from the same bounded `review()`.
* The real file contents stay in Agent 2's private `ai_control` task storage for the later commit; they are re-verified by SHA-256 at apply time.

## 5. Agent 2

Unchanged gates: owner approval in the Approvals tab, sensitive-file confirmation (`APPROVE-SENSITIVE`), own `agent2/*` branch, one commit, never main/master/production, no merge, CI status via `actions_status`, workflow stops on CI failure.

## 6. Agent 1 and SQL (this replaces the earlier "all SQL blocked" behaviour)

SQL files are never committed or sent to Gemini. Each file is classified at upload with Agent 1's own `classifyExecutableSql` (the existing allow-list: `ai_control` only; blocks `public/auth/storage/private/...`, billing/payout/ledger objects, DROP, TRUNCATE, RLS disabling, anon/public grants, comments, transaction/role/search_path changes, DELETE/UPDATE without WHERE, …).

* **Blocked** → shown with Agent 1's reason, never executed, never silently skipped; the code workflow continues but the final verdict is `attention` with "do NOT promote" guidance.
* **Reviewed** → flagged `destructive` if it contains DELETE / UPDATE / ALTER … DROP / ALTER COLUMN TYPE.
* The same migration (SHA-256) cannot be applied twice.
* After code approval → commit → **CI passes**, Agent 1 creates one separate `db_change` approval per file (stage `awaiting_sql`). Nothing runs before that.
* `apply_sql` needs: every approval approved, not executed, < 24 h, SQL checksum equal to the uploaded file, `db_ack = RUN-SQL`, and `destructive_ack = APPROVE-DESTRUCTIVE` when applicable. It runs through Agent 1's existing `apply_db_change` (single transaction, `search_path = ai_control`, 15 s timeout, atomic claim → no double execution). First failure stops everything; later files are marked `not_run`.
* Agent 1 verification (health report: Supabase RLS/schema, Vercel, GitHub) runs only after CI passed **and** all SQL is applied (`verify` is refused with `sql_pending` otherwise). Code is therefore never verified/promoted ahead of its migration.
* The Orchestrator's generic Agent 1 allow-list is unchanged (`health_report`); the two SQL actions live in a separate `A1_SQL_ALLOWED` list reachable only from the SQL stages.
* A ZIP containing only SQL is refused with a clear message (no code workflow to attach it to).

## 7. Sequence

upload → server validation → Agent 2 diff summary → Gemini (compact) → preview → code approval → Agent 2 commit on `agent2/*` → CI → (SQL approvals → Agent 1 run) → Agent 1 Supabase/Vercel verification → combined report → owner starts Agent 3 manually → production promotion stays a separate manual Agent 2 decision. Every failed stage stops the workflow.

## 8. Agent 3

No import, no call, no env var in `orchestrator/*`; asserted by the existing test plus the new ZIP/SQL full-flow test (Agent 3 row stays `offline`, no request to Agent 3 URLs).

## 9. Tests and build (executed here)

* `tsc` for agent1, agent2, agent3, orchestrator: **0 errors**.
* `node --test` over all four suites: **143 tests, 143 pass, 0 fail** (126 earlier + 17 new). All services mocked; no real GitHub/Supabase/Vercel/Gemini calls.
* New tests cover: no GitHub write on upload, create/update/delete detection, base SHA pin and base-moved refusal, duplicate ZIP, traversal/absolute/symlink/duplicate/binary/secret/unsupported/bomb/bad base64, Gemini payload ≤ 14,000 chars without ZIP/SQL/full files/secrets, partial flag, token usage row, SQL blocked/reviewed/destructive/rejected/tampered/failed, no double execution, CI failure before SQL, allow-lists, secret leakage.
* `vite build` could not be run in this environment (no network, Vite not installed). `src/Orchestrator.jsx` was compiled successfully with esbuild. Run `npm run build` once locally.

## 10. Manual verification before use

1. `npm install && npm test && npm run build`.
2. Preview deployment, non-production repo/Supabase: upload a ZIP with one create + one update; check base SHA, file list, diff preview, Gemini token row in API Usage.
3. Approve; confirm `agent2/*` branch + one commit; confirm CI failure stops the flow.
4. ZIP with a harmless `ai_control` migration: approve in Approvals, press "Run approved SQL", confirm one execution and the Agent 1 report.
5. ZIP with SQL touching `public.*`: confirm BLOCKED with reason.
6. Try traversal / symlink / secret ZIPs.
7. Confirm Agent 3 is only started manually.
