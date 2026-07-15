-- Disambiguate inbox threads when the same email is delivered to multiple recipients
-- (duplicate Message-ID / subject). mailbox_address = normalized recipient on inbound.

ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS mailbox_address text;

COMMENT ON COLUMN public.inbox_threads.mailbox_address IS
  'Normalized recipient mailbox for this thread copy (from first inbound to_identifier). Disambiguates sibling threads with the same subject/Message-ID.';

-- Prefer the synced mailbox account email. Message headers can show aliases/forwarded recipients,
-- but the account is the stable Jay-vs-Chris ownership dimension.
UPDATE public.inbox_threads t
SET mailbox_address = lower(trim(a.email))
FROM public.imap_accounts a
WHERE t.imap_account_id = a.id
  AND coalesce(trim(a.email), '') <> ''
  AND (t.mailbox_address IS NULL OR trim(t.mailbox_address) = '');

-- Backfill remaining rows from earliest inbound message per thread
UPDATE public.inbox_threads t
SET mailbox_address = sub.mailbox
FROM (
  SELECT DISTINCT ON (m.thread_id)
    m.thread_id,
    lower(trim(
      CASE
        WHEN coalesce(m.to_identifier, '') ~ '<[^>]+>'
          THEN regexp_replace(m.to_identifier, '^.*<([^>]+)>.*$', '\1')
        ELSE coalesce(m.to_identifier, '')
      END
    )) AS mailbox
  FROM public.inbox_messages m
  WHERE m.direction = 'inbound'
    AND coalesce(trim(m.to_identifier), '') <> ''
  ORDER BY m.thread_id, m.received_at ASC
) sub
WHERE t.id = sub.thread_id
  AND (t.mailbox_address IS NULL OR trim(t.mailbox_address) = '');

-- Outbound-only threads: use sender (our address) from earliest message
UPDATE public.inbox_threads t
SET mailbox_address = sub.mailbox
FROM (
  SELECT DISTINCT ON (m.thread_id)
    m.thread_id,
    lower(trim(
      CASE
        WHEN coalesce(m.from_identifier, '') ~ '<[^>]+>'
          THEN regexp_replace(m.from_identifier, '^.*<([^>]+)>.*$', '\1')
        ELSE coalesce(m.from_identifier, '')
      END
    )) AS mailbox
  FROM public.inbox_messages m
  WHERE coalesce(trim(m.from_identifier), '') <> ''
  ORDER BY m.thread_id, m.received_at ASC
) sub
WHERE t.id = sub.thread_id
  AND (t.mailbox_address IS NULL OR trim(t.mailbox_address) = '');

CREATE INDEX IF NOT EXISTS idx_inbox_threads_org_account_mailbox
  ON public.inbox_threads (org_id, imap_account_id, mailbox_address)
  WHERE mailbox_address IS NOT NULL;

DROP FUNCTION IF EXISTS public.search_inbox_threads(uuid, uuid, text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.search_inbox_threads(
  p_org_id uuid,
  p_user_id uuid,
  p_filter text DEFAULT 'inbox',
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  channel text,
  status text,
  subject text,
  last_message_at timestamptz,
  created_at timestamptz,
  from_address text,
  imap_account_id uuid,
  mailbox_address text,
  inbox_thread_assignments jsonb,
  message_count bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH visible_threads AS (
    SELECT t.*
    FROM public.inbox_threads t
    WHERE t.org_id = p_org_id
      AND EXISTS (
        SELECT 1
        FROM public.organization_users ou
        WHERE ou.org_id = t.org_id
          AND ou.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1
        FROM public.inbox_messages m
        WHERE m.thread_id = t.id
      )
      AND (
        CASE COALESCE(NULLIF(p_filter, ''), 'inbox')
          WHEN 'inbox' THEN t.status = 'open'
            AND (
              NOT EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id)
              OR EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id AND a.user_id = p_user_id)
            )
          WHEN 'assigned' THEN t.status = 'open'
            AND EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id AND a.user_id = p_user_id)
          WHEN 'closed' THEN t.status = 'closed'
            AND (
              NOT EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id)
              OR EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id AND a.user_id = p_user_id)
            )
          WHEN 'trash' THEN t.status = 'archived'
          WHEN 'all' THEN t.status <> 'archived'
          ELSE t.status = 'open'
        END
      )
      AND (
        NULLIF(BTRIM(COALESCE(p_query, '')), '') IS NULL
        OR t.subject ILIKE '%' || BTRIM(p_query) || '%'
        OR t.from_address ILIKE '%' || BTRIM(p_query) || '%'
        OR t.mailbox_address ILIKE '%' || BTRIM(p_query) || '%'
        OR EXISTS (
          SELECT 1 FROM public.imap_accounts ia
          WHERE ia.id = t.imap_account_id
            AND (ia.email ILIKE '%' || BTRIM(p_query) || '%' OR ia.label ILIKE '%' || BTRIM(p_query) || '%')
        )
        OR EXISTS (
          SELECT 1
          FROM public.inbox_messages m
          WHERE m.thread_id = t.id
            AND (
              m.from_identifier ILIKE '%' || BTRIM(p_query) || '%'
              OR m.to_identifier ILIKE '%' || BTRIM(p_query) || '%'
              OR m.cc ILIKE '%' || BTRIM(p_query) || '%'
              OR m.body ILIKE '%' || BTRIM(p_query) || '%'
              OR m.html_body ILIKE '%' || BTRIM(p_query) || '%'
            )
        )
      )
  )
  SELECT
    vt.id,
    vt.org_id,
    vt.channel,
    vt.status,
    vt.subject,
    vt.last_message_at,
    vt.created_at,
    vt.from_address,
    vt.imap_account_id,
    vt.mailbox_address,
    COALESCE(assignments.items, '[]'::jsonb) AS inbox_thread_assignments,
    COALESCE(counts.message_count, 0)::bigint AS message_count
  FROM visible_threads vt
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('user_id', a.user_id) ORDER BY a.assigned_at) AS items
    FROM public.inbox_thread_assignments a
    WHERE a.thread_id = vt.id
  ) assignments ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS message_count
    FROM public.inbox_messages m
    WHERE m.thread_id = vt.id
  ) counts ON true
  ORDER BY vt.last_message_at DESC, vt.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

GRANT EXECUTE ON FUNCTION public.search_inbox_threads(uuid, uuid, text, text, integer, integer) TO authenticated;
