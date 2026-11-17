# Orchestrator Test Report: Step 0 and Tests 1-3

Blisscco AI Control Center · Date: 17 Nov 2026 · Tested by: owner, manually from the dashboard on Android (aicentre.vercel.app)

## Summary

| Test | Kya check hua | Result |
| --- | --- | --- |
| Step 0 | Deploy check | PASS |
| Test 1 | Monitor aur Health (read-only) | PASS |
| Test 2 | Chhota code change (JSON mode) | PASS |
| Test 3 | ZIP upload | PASS (3 fixes ke baad) |

Abhi tak koi production change nahi hua. Orchestrator ne sirf `agent2/*` branches par kaam kiya.

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

## Code ki testing (meri taraf se, mocked)

- 180 automated tests pass, `tsc` ke 4 projects mein 0 errors.
- Ye tests nakli (mock) GitHub/Supabase/Vercel par chale. `vite build` mere environment mein nahi chala, wo Vercel build mein chalta hai.

## Baaki tests

| Test | Kya karna hai | Kya dikhna chahiye |
| --- | --- | --- |
| Test 4: Safety | ZIP mein `api/x.js` ya `.github/...` daalo. Phir `.env` ya fake secret wali ZIP. Phir `package.json` wala change | Protected path `protected_path` se refuse. Secret wali pura ZIP reject. `package.json` par confirm checkbox tick kiye bina aage nahi badhega |
| Test 5: Failure aur recovery | Jaan-bujhkar build tod do (galat syntax wali file). Approve ke baad page refresh karo | Card par agent, stage, task, asli error log aur recovery dikhe. Agent 1 start na ho (Blocked). Refresh ke baad workflow wahin se dikhe, duplicate commit na ho |
| Test 6: SQL (sambhal ke) | Sirf `ai_control` schema ki harmless migration. Phir `public.*` ko chhune wali SQL. Phir `DELETE ... WHERE` wali SQL | Harmless SQL ke liye alag approval, ek hi baar chale. `public.*` wali BLOCKED. DELETE wali par extra destructive confirmation |
| Test 7: Cancel aur indicator | Approval ke intezaar wale task par Cancel dabao. Naya task banao aur Approvals ka green dot dekho | Cancel hone par task Cancelled dikhe. Pending approval par green dot aaye, decide karne par hat jaye |
| Test 8: Agent 3 alag | Orchestrator task poora chalao | Agent 3 apne aap start na ho ("It was not triggered") |

Test 6 sirf non-production setup par karna.

## Open items

- Supabase security findings (Test 2) alag kaam hain: `customer_push_subscriptions` aur `visit_requests` ki anon write policy. Agar ye public forms ke liye jaan-bujhkar hain to rate limit chahiye, warna policy kasna padega. Billing/payout tables ko haath nahi lagana.
- Agar `next/font` ka error baar-baar aaye to font ko local file se load karna padega (`next/font/local`), taaki CI Google par depend na kare.
