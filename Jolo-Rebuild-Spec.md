# Jolo Rebuild – AI‑First Spec (v1)

## 1) Product Goals
- Rebuild JoloCRM into **jolo** (lowercase) as “business software,” not “CRM.”
- Keep legacy CodeIgniter app live at **jolocrm.com**.
- Launch new app at **app.gojolo.io** under **gojolo.io**.
- **AI‑first**: chat is a first‑class interface for all workflows; UI can be a data capture surface for AI.

## 2) Core Decisions (Locked)
- **Workspace picker** on login (no path‑based routing).
- Users can belong to **multiple Organizations**.
- **Global notifications** across orgs (filtered by org).
- **No client portal** or ticket system.
- **Threads = unified email + SMS** with bi‑directional sync.
- **No Calendar in v1**.
- AI provider: **OpenAI**.

## 3) Tech Stack (Proposed)
- **Frontend**: React + TypeScript (Vercel hosting).
- **Backend**: Supabase (Postgres + RLS + Auth + Storage).
- **AI Layer**: OpenAI via a tooling gateway (centralized policy + audit).
- **Workers**: Cloudflare Workers for command runner + webhooks (Twilio + GogCLI).
- **Integration tools**:
  - **Gmail**: `gogcli` as the command runner for IMAP + send.
  - **Twilio**: SMS inbound/outbound.

## 4) Core Modules (Build Order)
1. **Supabase Auth** w/ Google sign‑in
2. **Organizations** + switcher (multi‑org membership)
3. **Contacts** + **Companies** (1‑to‑many, contact types)
4. **Threads** (Gmail IMAP + Twilio SMS)
5. **Projects**
6. **Tasks**
7. **Time Logs**
8. **Invoices**
9. **Vendors**

## 5) Data Model (High‑Level)
### Organizations
- `organizations` (id, name, slug, settings)
- `organization_users` (org_id, user_id, role_id)
- `roles` (name, permissions json)

### Users
- Supabase `auth.users`
- `profiles` (user_id, display_name, avatar)

### Contacts & Companies
- `companies` (org_id, name, industry, meta)
- `contacts` (org_id, company_id, type, name, email, phone, meta)

### Threads & Messages
- `threads` (org_id, contact_id, channel: email|sms, subject, status)
- `messages` (thread_id, direction in|out, body, sent_at, provider_id)
- `thread_participants` (thread_id, contact_id)

### Projects / Tasks
- `projects` (org_id, name, status, lead_contact_id)
- `tasks` (project_id, assignee_id, status, due_date, priority)

### Timelogs / Invoices / Vendors
- `timelogs` (task_id, vendor_id, hours, rate)
- `invoices` (org_id, project_id, status, total)
- `vendors` (org_id, name, contact_id)

## 6) AI‑First Behavior
### AI as the Source of Truth
- UI actions **write to DB** directly when user role allows.
- Chat actions **write to DB** when role allows; require **confirmation** for high‑risk actions.
- All AI actions are logged with input, output, and DB mutations.

### Guardrails
- Role‑based permissions (same as UI).
- Explicit “dangerous action” blocklist (e.g., delete all, drop tables).
- Confirmations for: invoice creation/sends, bulk deletes, org settings.

## 7) Inbox / Notifications
- Global notification feed across all orgs.
- Filters by org + type (threads, tasks, invoices, mentions).
- Priority scoring (AI‑assisted later).

## 8) Threads Module (Bi‑Directional)
### Gmail
- Org‑level OAuth once; permissions controlled by roles.
- `gogcli` runner handles:
  - fetch threads / messages
  - send replies
  - label / archive

### Twilio
- Webhooks to Cloudflare Worker → Supabase
- Outbound SMS via worker → Twilio

### AI Interfacing
- AI can:
  - summarize threads
  - draft replies
  - classify / link to contacts
  - auto‑assign to projects

## 9) Chat Mode vs Software Mode
- **Software Mode**: Traditional UI + tables
- **Chat Mode**: Org‑scoped conversation with drill‑downs
- Tables/filters can be AI‑driven (prompt → query → results)

## 10) Security / Compliance
- RLS for tenant isolation
- Command runner allowlist
- Audit log for every AI + integration action
- Webhook verification for Twilio

## 11) MVP Roadmap (Suggested)
**Phase 1**
- Auth (Google) + Org switcher
- Contacts + Companies
- Basic Threads (read + send Gmail/SMS)

**Phase 2**
- Projects + Tasks
- Timelogs
- AI chat mode for queries + updates

**Phase 3**
- Invoices + Vendors
- Advanced AI workflows + automation

---

## Open Questions (if any)
- Final decision: Vercel + Supabase + Cloudflare Workers (✅ assumed)
- Confirm AI provider: OpenAI (✅ confirmed)
