# Implementation Sequence

0. Approve architecture (this package).
1. (Done) Inspect Denim Hub Bsl read-only - see 07-INSPECTION-REPORT.md.
2. Create NEW GitHub repo + branch `phase1-control-center`.
3. AFTER YOUR APPROVAL: apply 03-DATABASE-SCHEMA.sql, add `ai_control` to Exposed schemas, insert owner row, run 08-VERIFY.sql and compare with baseline.
4. Scaffold project in Termux, flat structure (see 04).
5. Auth: login screen + session guard.
6. Layout: mobile bottom navigation + 8 sections.
7. Agents + Overview (realtime).
8. Tasks, Activity Logs.
9. Approval Center.
10. API Usage + System Health (+ /api/health).
11. Settings + PWA manifest.
12. Tests, secret scan, mobile check.
13. Vercel Preview deploy, env vars (Preview scope only).
14. Phase 1 verification report with PASS/FAIL (Prompt 3).

## Termux setup (Android)
```
pkg update && pkg upgrade
pkg install git nodejs
git config --global user.name "YOUR_NAME"
git config --global user.email "YOUR_EMAIL"
git clone https://github.com/YOUR_USER/blisscco-ai-control-center.git
cd blisscco-ai-control-center
git checkout -b phase1-control-center
```
Daily loop: edit in SPCK -> `npm run build` in Termux -> `git add . && git commit -m "msg" && git push` -> Vercel auto-builds a Preview.

## Not allowed in Phase 1
Building the 3 agents or orchestrator, touching Blisscco production, destructive SQL.
