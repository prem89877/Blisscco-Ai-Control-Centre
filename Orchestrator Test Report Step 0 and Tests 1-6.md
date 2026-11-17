# Orchestrator Test Report: Step 0 aur Tests 1-6

Blisscco AI Control Center · Date: 17 Nov 2026 · Tested by: owner, manually from the dashboard on Android (aicentre.vercel.app)

## Summary

| Test | Kya check hua | Result |
| --- | --- | --- |
| Step 0 | Deploy check | PASS |
| Test 1 | Monitor aur Health (read-only) | PASS |
| Test 2 | Chhota code change (JSON mode) | PASS |
| Test 3 | ZIP upload | PASS (3 fixes ke baad) |
| Test 4 | Safety (protected path, secret, sensitive file) | PASS |
| Test 5 | Failure aur recovery | PASS (1 cheez confirm baaki) |
| Test 6 | SQL (testing Supabase project par) | PASS (DELETE wala hissa baaki) |

Abhi tak koi production change nahi hua. Orchestrator ne sirf `agent2/*` branches par kaam kiya. Test 6 sirf testing Supabase project par chala (owner ne confirm kiya, asli project nahi).

## Step 0: Deploy check

- GitHub: latest CI check green.
- Vercel: latest commit deploy ho chuka tha.
- Orchestrator tab dikha aur repo list aayi.

**Result: PASS.**

## Test 1: Monitor aur Health

Screenshot se confirm hua:

- Approvals: None Pending. Running tasks: nothing is running. Recently completed: none.
- Health: Orchestrator, Agent 1, Agent 2, Gemini API, GitHub, Supabase, Vercel sab Healthy.
- Agent 3 "independent" dikha (apne aap start nahi hua).
- Operational: 0 active, 0 failed, 0 pending approval, 0 interrupted.

**Result: PASS.**

## Test 2: Chhota code change

- Task: `Orchestrator test 1`, file `docs/orch-test.md` (create).
- Agent 2 ne branch `agent2/orchestrator-test-1-2611170420` par commit kiya. Main untouched raha.
- CI pass hui, isliye Agent 1 ne verify kiya.
- Agent 1 report: GitHub ok, Vercel ok (preview READY), Supabase **attention**.
- Agent 1 ka overall status **critical** aaya. Wajah Supabase ke purane security findings hain, is test se juda nahi:
  - critical/error: `public.customer_push_subscriptions` (anonymous INSERT bina condition, anon write + RLS barrier nahi).
  - error: `public.visit_requests` (anon write + RLS barrier nahi).
  - warn: `public.admins`, `public.products`, `public.push_subscriptions` (anon write GRANT hai par RLS abhi block kar raha hai).
  - info: 36 tables RLS on aur policy nahi (deny-all, normal).
- Orchestrator ne promotion nahi kiya. Production par jaana alag Agent 2 approval se hi hoga.

**Result: PASS.** Orchestrator ne warning sahi dikhayi. Supabase findings alag kaam hain (neeche Open items dekho).

## Test 3: ZIP upload

Test file: `orch-zip-test.zip` (2 nayi files: `docs/orch-zip-test-1.md`, `docs/orch-zip-test-2.md`).

Is test mein teen cheezein mili aur teeno fix hui:

| # | Kya hua | Wajah | Fix |
| --- | --- | --- | --- |
| 1 | CI fail hui, logs mein sirf step ka naam tha | Dashboard failed step ka log laata hi nahi tha | CI failure par failed step ka pura error log Orchestrator card aur Agent 2 console mein dikhta hai. Success par koi log nahi (`ci-error-logs-update.zip`) |
| 2 | Wahi ZIP dobara upload nahi hui (`duplicate_zip`) | Ek ZIP ka lock hamesha ke liye rehta tha | Finished task par red Delete button; delete par ZIP aur commit lock hat jate hain. Error message ab batata hai kya karna hai (`delete-reupload-update.zip`) |
| 3 | Delete par error: `activity_logs is append-only` | Row seedha delete karne ki koshish, jabki logs append-only hain | Delete ab task ko hide karta hai (row audit ke liye rehti hai). Tasks tab se bhi hide hota hai (`delete-fix-update.zip`) |

CI ka pehla failure Orchestrator ya ZIP ki galti nahi tha. Error `app/layout.tsx` ke `next/font` (Google Fonts) ka tha, GitHub runner par font fetch fail hua. Dobara chalane par error nahi aaya, to wo flaky lagta hai.

Final result: task **Completed with warnings** par pahuncha, CI ka error dobara nahi aaya.

- Duplicate ZIP protection kaam karti dikhi (`duplicate_zip`).
- Delete aur re-upload ab chal rahe hain.
- "Warnings" ka matlab Agent 1 ka verdict healthy se kam hona hai. Test 2 jaise Supabase findings ki wajah se hone ki sambhavna hai; Report ke warnings box se confirm kar lena.

**Result: PASS.**

Note: ZIP ki file list, diff preview aur base SHA ke alag screenshot report mein nahi aaye. Workflow aage chal gaya, isliye validate/preview step chala hua maana gaya hai.

## Test 4: Safety

Teeno cases mein refuse/reject hona hi sahi result tha.

| # | ZIP mein kya tha | Result |
| --- | --- | --- |
| 1 | `api/x.js` | Refuse hui: "This ZIP touches protected deployment/security files and was refused: api/x.js. ... Nothing was stored or applied." |
| 2 | `docs/ok.md` (harmless) + `docs/secret-test.md` (nakli AWS key) | Pura ZIP reject: "Secret scan blocked docs/secret-test.md (AWS key id line 1)". Harmless `ok.md` bhi apply nahi hui. Error mein sirf rule aur line aayi, key ki value nahi |
| 3 | Nayi file `docs/orch-sens-test/package.json` (sensitive path, asli `package.json` ko nahi chhua) | Owner ne confirm checkbox wala flow poora kiya (checkbox ke bina aage nahi badhna, tick ke baad badhna). Iska alag screenshot report mein nahi hai |

**Result: PASS.**

## Test 5: Failure aur recovery

**Step 1: CI jaan-bujhkar tod di.** ZIP mein `orch-ci-break-test.ts` thi (syntax error). Card par ye dikha:

- Agent: `agent2`, Stage: `ci_waiting`, Task: GitHub CI, Code: `ci_failed`
- Message: GitHub Actions CI failed for commit `3ee9736`. Failed check: Type check (`npm run lint` = `tsc --noEmit`) aur Production build
- Asli error log: `orch-ci-break-test.ts(1,40): error TS1109`, `(2,10): TS1003`, `(3,1): TS1005`

**Confirm baaki:** "Agent 1 start nahi hua (Blocked)" aur "recovery guidance dikhi" ka alag screenshot ya confirmation is report mein nahi hai.

**Step 2: Approve ke baad refresh.** ZIP: `docs/orch-refresh-test.md`.

- Approve ke baad page refresh kiya. Failed card refresh ke baad bhi wahin dikha (workflow gayab ya reset nahi hua).
- GitHub branch `agent2/zip-tests-...` par sirf **1 commit** hai: "ZIP tests 5 refresh" (`dc01d22`). Duplicate commit nahi bana (screenshot se confirm).
- Is baar CI ka fail Orchestrator ki wajah se nahi tha. Wahi purana flaky `next/font` (Google Fonts, `Inter` in `app/layout.tsx`) error aaya, jisme GitHub runner par font fetch fail hota hai.

**Result: PASS** (sirf Agent 1 Blocked / recovery guidance wala hissa confirm baaki).

## Test 6: SQL (testing Supabase project)

**Harmless `ai_control` migration.** ZIP: `migrations/orch_test_001_ai_control.sql` (table `ai_control.orch_sql_test` banati hai) + `docs/orch-sql-test.md`.

- Pehli koshish mein SQL-only ZIP aayi: "This ZIP has SQL files only. Include at least one code change; a SQL-only deployment is not supported by this workflow." Ye workflow ka rule hai, bug nahi. ZIP mein ek doc file jodne par chal gayi.
- CI pass hone ke baad alag SQL approval aayi, owner ne approve kiya, workflow poora hua (owner confirm).
- Agent 1 ki baad ki report mein `ai_control.orch_sql_test` dikhi, yani table sach mein ban gayi.
- "Ek hi baar chali" ka alag screenshot report mein nahi hai. SQL `create table if not exists` hai, to dobara chalne par bhi nuksan nahi hota.

**`public.*` wali SQL.** ZIP: `migrations/orch_test_002_public.sql` (`public.orch_block_test` banane ki koshish) + `docs/orch-sql-block-test.md`.

- Agent 1 ne **BLOCKED** dikhaya, SQL execute nahi hui: "SQL migration migrations/orch_test_002_public.sql is BLOCKED and was NOT executed: Agent 1 safeguards: Only ai_control schema changes can be proposed. Code that depends on it must not be promoted until the migration is handled separately."
- Card par SQL approval ke steps nahi bane, aur owner ne SQL approve nahi ki.

**Naya finding (hamare test se):** Agent 1 ki report mein `critical [supabase] RLS is disabled - ai_control.orch_sql_test`. Ye test table hamari banayi hui hai. Testing project par isko hata dena chahiye ya RLS on kar deni chahiye.

**Result: PASS.** `DELETE ... WHERE` wali SQL par destructive confirmation abhi test nahi hui.

## Code ki testing (meri taraf se, mocked)

- 180 automated tests pass, `tsc` ke 4 projects mein 0 errors.
- Ye tests nakli (mock) GitHub/Supabase/Vercel par chale. `vite build` mere environment mein nahi chala, wo Vercel build mein chalta hai.

## Baaki tests

| Test | Kya karna hai | Kya dikhna chahiye |
| --- | --- | --- |
| Test 6 (bacha hissa): DELETE SQL | Testing project par `ai_control` mein `DELETE ... WHERE` wali SQL | Extra destructive confirmation maangna chahiye |
| Test 7: Cancel aur indicator | Approval ke intezaar wale task par Cancel dabao. Naya task banao aur Approvals ka green dot dekho | Cancel hone par task Cancelled dikhe. Pending approval par green dot aaye, decide karne par hat jaye |
| Test 8: Agent 3 alag | Orchestrator task poora chalao | Agent 3 apne aap start na ho ("It was not triggered") |

## Open items

- Supabase security findings (Test 2) alag kaam hain: `customer_push_subscriptions` aur `visit_requests` ki anon write policy. Agar ye public forms ke liye jaan-bujhkar hain to rate limit chahiye, warna policy kasna padega. Billing/payout tables ko haath nahi lagana.
- `next/font` ka flaky error ab do baar aa chuka hai (Test 3 aur Test 5). Ab font ko local file se load karna chahiye (`next/font/local`), taaki CI Google par depend na kare.
- Testing project se test table `ai_control.orch_sql_test` hata do ya uski RLS on karo, warna Agent 1 ka status critical dikhta rahega.
- Test 5 mein "Agent 1 Blocked" aur "recovery guidance" ka confirm baaki hai.
