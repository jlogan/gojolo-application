# AGENTS.md

## Cursor Cloud specific instructions

### Overview

**jolo** is an AI-first business software app (React + TypeScript SPA) backed by Supabase (Postgres, Auth, Edge Functions). See `README.md` for full setup docs.

### Services

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| Vite dev server | `npm run dev` | 5173 | React SPA frontend |
| Supabase (local) | `sudo supabase start` | 54321 (API), 54322 (DB), 54323 (Studio) | Requires Docker; runs Postgres, Auth, Edge Functions, Studio |
| Edge Functions | `sudo supabase functions serve --no-verify-jwt --env-file <file>` | via 54321 | Required for AI chat; env file must contain `OPENAI_API_KEY` |

### Running locally

1. Docker must be running (`sudo nohup dockerd > /tmp/dockerd.log 2>&1 &`).
2. Start local Supabase: `cd /workspace && sudo supabase start`. This pulls images on first run (~1-2 min), applies all migrations from `supabase/migrations/`, and outputs API URL + keys.
3. Create `.env` from `.env.example` with the local Supabase URL (`http://127.0.0.1:54321`) and anon key from `supabase status -o env`.
4. `npm run dev` starts the Vite dev server at `http://localhost:5173`.

### Auth for local testing

- Local Supabase supports email/password signup directly (no email confirmation needed).
- Sign up via the Supabase Auth API: `POST http://127.0.0.1:54321/auth/v1/signup` with `apikey` header and `{"email":"...","password":"..."}`.
- The first user to sign up is automatically made a **platform admin** (via the `bootstrap_platform_admin` trigger). Platform admins can create organizations and invite users.
- Google OAuth is not available in local dev unless configured in `supabase/config.toml` under `[auth.external.google]`.

### Lint / Type-check / Build

- `npm run lint` — requires an `eslint.config.js` (ESLint v9 flat config). **Note:** the repo currently has no ESLint config file, so this command fails. This is a pre-existing repo issue.
- `npx tsc -b` — TypeScript type-check. There are pre-existing type errors in `src/pages/Inbox.tsx`. These don't block the dev server (Vite skips type-checking).
- `npm run build` — runs `tsc -b && vite build`. Fails due to the TS errors above, but `npx vite build` (Vite-only) succeeds.
- No automated test framework is configured in the repo.

### Edge Functions (AI Chat)

- The `ai-chat` Edge Function powers Chat mode. It requires `OPENAI_API_KEY` in the Deno runtime environment.
- For local dev, `supabase functions serve` does **not** inherit shell env vars. Pass them via `--env-file`: create a file with `OPENAI_API_KEY=sk-...` and reference it.
- `supabase start` alone does **not** serve Edge Functions for local requests. You must also run `supabase functions serve` in a separate process.
- The function uses OpenAI function-calling (`gpt-4o-mini`) with 15 tools covering projects, tasks, contacts, companies, and team members.

### Projects & Tasks module

- Tables: `projects`, `tasks`, `project_members`, `project_companies`, `project_contacts`, `task_attachments`, `chat_messages`.
- File uploads use Supabase Storage bucket `task-attachments`.
- Project detail page (`/projects/:id`) has inline task CRUD, team member management, and company/contact linking.
- "My projects" filter on the list page shows only projects the user is a member of (via `project_members`).
- Anything doable in the UI can also be done via Chat mode (AI function-calling).

### Database

- Local Postgres is accessible at `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
- Supabase Studio at `http://127.0.0.1:54323` provides a GUI for tables, SQL editor, etc.
- Direct DB queries: `sudo docker exec -i supabase_db_workspace psql -U postgres -d postgres -c "SQL_HERE"`.
