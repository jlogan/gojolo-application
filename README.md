# jolo

Business software (not CRM). AI-first app at **app.gojolo.io**.

- **Stack:** React + TypeScript (Vite), Supabase (Auth, Postgres, RLS, Edge Functions), Resend (email), Vercel (hosting).
- **Features (Phase 1):** Google sign-in, workspace picker, organizations, contacts, companies, Chat/Software mode switcher.

---

## What you need to do

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the Supabase dashboard:
   - **Authentication → Providers:** enable **Google** and add your OAuth client ID and secret (from Google Cloud Console).
   - **Project Settings → API:** copy **Project URL** and **anon public** key.
3. Install Supabase CLI and link the project (from this repo root):

   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```

   (`YOUR_PROJECT_REF` is in the project URL: `https://YOUR_PROJECT_REF.supabase.co`.)

4. Run migrations:

   ```bash
   supabase db push
   ```

   Or apply the SQL in `supabase/migrations/20250226000001_initial_schema.sql` manually in the SQL editor.

5. **Secrets:** All sensitive API keys live in Supabase (Edge Function secrets). See **[SECRETS.md](SECRETS.md)** for the full list and commands. For Resend:

   ```bash
   supabase secrets set RESEND_API_KEY=re_xxxx
   ```

   Optional: `supabase secrets set RESEND_FROM="jolo <notifications@yourdomain.com>"` (verified domain in Resend).

### 2. Environment (local)

```bash
cp .env.example .env
```

Fill in (these are **public**; no other secrets go here – see [SECRETS.md](SECRETS.md)):

- `VITE_SUPABASE_URL` – Supabase project URL
- `VITE_SUPABASE_ANON_KEY` – Supabase anon key

### 3. Resend

1. Sign up at [resend.com](https://resend.com).
2. Create an API key and add it as `RESEND_API_KEY` in Supabase Edge Function secrets (see above).
3. For production, verify your domain and set `RESEND_FROM` to a sender on that domain.

### 4. Vercel (when you deploy)

1. Push this repo to GitHub and import the project in Vercel.
2. Add **only** these env vars in Vercel: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. (All other secrets stay in Supabase; see [SECRETS.md](SECRETS.md).)
3. In Supabase **Authentication → URL Configuration**, add your Vercel URL (e.g. `https://your-app.vercel.app`) to **Redirect URLs**.

### 5. Google OAuth (if not done)

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. Create OAuth 2.0 Client ID (Web application).
3. Authorized redirect URIs: add `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`.
4. Copy Client ID and Secret into Supabase Auth → Google provider.

---

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Sign in with Google, create or pick a workspace, then use Contacts and Companies.

---

## Email (Resend)

All transactional email (invites, notifications) goes through the **send-email** Edge Function, which uses Resend. From the app:

```ts
import { sendEmail } from '@/lib/email'

await sendEmail({
  to: 'user@example.com',
  subject: 'You were invited to jolo',
  html: '<p>...</p>',
})
```

The function is in `supabase/functions/send-email/`. Deploy with:

```bash
supabase functions deploy send-email
```

---

## Project layout

- `src/` – React app (contexts, components, pages)
- `supabase/migrations/` – Postgres schema and RLS
- `supabase/functions/` – Edge Functions (e.g. send-email)
- `Jolo-Rebuild-Spec.md` – Product spec
