# Blisscco AI Control Center - Phase 1 / Part 1 (v2: ai_control schema)

STATUS: planning + inspection only. NO migration executed. Waiting for SQL approval.


Target DB: existing TEST project "Denim Hub Bsl" -> new isolated schema `ai_control`.
Blisscco-Ad-network- project: not touched.

Files (flat, no nesting):
- 00-README.md                  this file + decisions needed
- 01-ARCHITECTURE.md            architecture + isolation model
- 02-TECH-STACK.md              technology choices
- 03-DATABASE-SCHEMA.sql        PROPOSED ai_control migration (not executed)
- 04-FOLDER-STRUCTURE.md        project layout (max 1 level)
- 05-SECURITY.md                security architecture
- 06-IMPLEMENTATION-SEQUENCE.md build order + Android commands
- 07-INSPECTION-REPORT.md       what exists in Denim Hub Bsl + baseline + risks
- 08-VERIFY.sql                 read-only checks to run after migration

## Decisions needed from you
1. Approve 03-DATABASE-SCHEMA.sql as is (or ask changes)?
2. Which EXISTING admin email should become the AI Control owner? (no new signup, see report risk 2)
3. OK to add `ai_control` to Dashboard > API > Exposed schemas? (required)
4. Realtime: skip (polling every 10s, recommended) or add to shared publication?
5. New separate Vercel project for the dashboard? (existing Preview config stays untouched)
