# Folder Structure (shallow: max 1 folder level, no file/file/file nesting)

```
blisscco-ai-control-center/
  package.json
  vite.config.js
  vercel.json
  index.html
  .gitignore
  .env.example            <- placeholders only, no real values
  README.md
  src/                    <- ALL frontend files directly here (no sub-folders)
    main.jsx
    App.jsx
    supabaseClient.js
    auth.jsx
    styles.css
    Overview.jsx
    Agents.jsx
    Tasks.jsx
    Logs.jsx
    Approvals.jsx
    ApiUsage.jsx
    Health.jsx
    Settings.jsx
    Nav.jsx
    Login.jsx
  api/                    <- Vercel serverless functions, flat
    health.js
    heartbeat.js          (Phase 2)
  public/
    manifest.json
    icon.png
  sql/
    ai_control_schema.sql <- same as 03-DATABASE-SCHEMA.sql (reference copy)
```

Rules: no folder inside src/, api/, public/ or sql/.
.env and node_modules are git-ignored.

Supabase client: createClient(url, anonKey, { db: { schema: 'ai_control' } }) in src/supabaseClient.js
