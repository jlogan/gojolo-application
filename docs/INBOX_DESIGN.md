# Inbox Design: Email + SMS (Missive-style)

Lightweight shared inbox: check new mail, assign threads to users, close/archive, search. Email (IMAP) and SMS (Twilio) threads appear in one place.

## Reference: Legacy jolocrm-core IMAP

- **Accounts**: `jolocrm-core/modules/imap_accounts` — `Mail_accounts_model` (imap_host, imap_port, imap_encryption, imap_username, imap_password base64, smtp_*, last_fetch, last_fetched_uid, last_error).
- **Connection**: `IMAP_Connection.php` uses `php-imap` (PhpImap\Mailbox). Gmail → `[Gmail]/All Mail`, others → `INBOX`. Incremental fetch by UID; optional headers-only.
- **Threads**: `Mail_threads_model` — status (open/closed/deleted), assigned_to, inbox views (inbox, assigned, all, trash).
- **Messages**: `Mail_messages_model` — account_id, message_uid, message_id (dedup), thread_id, body, from/to, received_at.
- **Folders**: See `IMAP_FOLDER_STRUCTURE.md` — Gmail = `[Gmail]/All Mail`, else INBOX; cron incremental, manual fetch last 30 days.

## Library for email (Node/TS)

- **imapflow** (npm): Modern, promise-based IMAP client. Works in Node; can be used from Supabase Edge Functions via `npm:imapflow` in Deno if the runtime supports it.
- **Where to run**: Prefer a **scheduled Worker or cron** (Node) for sync so we’re not bound by Deno limits. Use an **Edge Function** only for: (1) **test connection** (credentials in request body, never stored in client), (2) **store credentials** (encrypt and write to DB/Vault). Sync job can run in a small Node service or Supabase cron calling an Edge Function that uses `imapflow` if Deno compatibility is verified; otherwise run sync in the Node worker.

## Credentials

- **Never** send or store raw passwords in the client.
- **Flow**: UI sends host/port/username/password (and optional label/email) to an Edge Function. Edge Function tests IMAP connection; on success it encrypts the password (e.g. with `ENCRYPTION_KEY` in env) and stores ciphertext in `imap_accounts` (e.g. `credentials_encrypted` or separate columns). Optionally use Supabase Vault if available.
- **Sync**: Sync process (Edge Function or external Worker) reads encrypted credentials, decrypts, connects with imapflow, fetches, writes threads/messages to Supabase.

## Database schema (unified threads)

### `imap_accounts` (extended)

- Keep: id, org_id, label, email, host, port, use_tls, is_active, created_at, updated_at.
- Add: `imap_username` (text), `credentials_encrypted` (text, ciphertext), `last_fetch_at` (timestamptz), `last_fetched_uid` (bigint), `last_error` (text), `imap_folder` (text, default Gmail = `[Gmail]/All Mail`, else `INBOX` — or derive in code and omit column).

### `inbox_threads` (email + SMS)

- id (uuid), org_id (uuid), channel (`email` | `sms`), status (`open` | `closed` | `archived`), subject (text, null for SMS), created_at, updated_at, last_message_at.
- Optional: source_id — for email = imap_account_id, for SMS = phone_number_id (or derive from first message).
- Indexes: org_id, (org_id, status), (org_id, last_message_at).

### `inbox_thread_assignments`

- thread_id (uuid), user_id (uuid), assigned_at (timestamptz). One assignment per thread (or allow multiple for “collaborative” later).

### `inbox_messages`

- id (uuid), thread_id (uuid), channel (`email` | `sms`), direction (`inbound` | `outbound`), from_identifier (text: email or phone), to_identifier (text), body (text), external_id (text: IMAP Message-ID or Twilio SID), external_uid (bigint, for IMAP UID; null for SMS), received_at (timestamptz), meta (jsonb).
- For email: imap_account_id (uuid); for SMS: phone_number_id (uuid).
- Unique constraint: (imap_account_id, external_uid) for email; (phone_number_id, external_id) for SMS where applicable.
- Indexes: thread_id, received_at, and for dedup (imap_account_id, external_uid).

This mirrors legacy mail_threads / mail_messages and supports assignment and status (open/closed/archived).

## IMAP folder mapping

- **Simple (MVP)**: No extra table. In code: if host contains `gmail.com` use `[Gmail]/All Mail`, else `INBOX`. Matches legacy.
- **Later**: Add `imap_folders` (imap_account_id, folder_path, last_fetched_uid, sync_enabled) so users can pick folders (e.g. INBOX + Sent).

## Edge functions

- **imap-test-and-save**: POST body: `{ orgId, email, host, port, useTls, username, password, label?, save? }`. Test connection with imapflow; if `save` is true and ENCRYPTION_KEY is set, encrypt password and insert into `imap_accounts` (using service role). Requires Authorization header (user must be org admin). **Secrets**: `ENCRYPTION_KEY` (32-byte hex, e.g. 64 chars) for saving; `SUPABASE_SERVICE_ROLE_KEY` for insert.
- **imap-sync** (optional): Called by cron or Worker; for each active account, connect, fetch since last_fetched_uid, create/update inbox_threads and inbox_messages. Or run this in a Node Worker and write to Supabase via service role.

## Sync flow

1. Cron or Worker triggers sync (e.g. every 5 min).
2. For each active imap_account: decrypt credentials, connect with imapflow to `imap_folder` (or Gmail/INBOX logic), fetch since last_fetched_uid.
3. For each new message: resolve or create thread (by References/In-Reply-To and account), insert message, update thread last_message_at.
4. Update imap_account last_fetch_at, last_fetched_uid, clear last_error on success.

## UI (current + next)

- **Admin → IMAP**: Full form (host, port, encryption, username, password) + “Test connection” (calls Edge Function with credentials). On success, “Add account” saves via same Edge Function (test + store). List accounts; no password shown.
- **Inbox**: List threads (email + SMS), filters (inbox / assigned / all / archived), assign, close/archive, search. Reuse patterns from legacy get_inbox_threads (view, account_id, search, limit/offset).

## Summary

| Topic | Choice |
|-------|--------|
| Library | **imapflow** (Node/TS); Edge Function can try `npm:imapflow` for test/save. |
| Where sync runs | Edge Function (if imapflow works in Deno) or **Node Worker** (recommended). |
| Credentials | Edge Function only; encrypt and store in DB; never in client. |
| Threads/messages | **inbox_threads** + **inbox_messages**; channel = email \| sms; assignments table. |
| Folders | MVP: Gmail = `[Gmail]/All Mail`, else INBOX in code. Optional later: imap_folders table. |
