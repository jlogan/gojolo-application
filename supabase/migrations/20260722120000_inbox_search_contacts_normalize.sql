-- Extend inbox search to linked contacts/companies and normalized (no-space) matching.
-- Allows service-role callers (e.g. ai-chat) via p_user_id when auth.uid() is null.

CREATE OR REPLACE FUNCTION public.normalize_inbox_search_text(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(lower(COALESCE(p_text, '')), '\s+', '', 'g');
$$;

CREATE OR REPLACE FUNCTION public.inbox_search_field_matches(p_field text, p_query text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    COALESCE(p_field, '') ILIKE '%' || BTRIM(p_query) || '%'
    OR (
      length(public.normalize_inbox_search_text(BTRIM(p_query))) >= 2
      AND public.normalize_inbox_search_text(p_field) LIKE '%'
        || public.normalize_inbox_search_text(BTRIM(p_query)) || '%'
    );
$$;

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
      AND (
        auth.uid() IS NULL
        OR auth.uid() = p_user_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.organization_users ou
        WHERE ou.org_id = t.org_id
          AND ou.user_id = COALESCE(auth.uid(), p_user_id)
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
        OR public.inbox_search_field_matches(t.subject, p_query)
        OR public.inbox_search_field_matches(t.from_address, p_query)
        OR public.inbox_search_field_matches(t.mailbox_address, p_query)
        OR EXISTS (
          SELECT 1 FROM public.imap_accounts ia
          WHERE ia.id = t.imap_account_id
            AND ia.org_id = p_org_id
            AND (
              public.inbox_search_field_matches(ia.email, p_query)
              OR public.inbox_search_field_matches(ia.label, p_query)
            )
        )
        OR EXISTS (
          SELECT 1
          FROM public.inbox_messages m
          WHERE m.thread_id = t.id
            AND (
              public.inbox_search_field_matches(m.from_identifier, p_query)
              OR public.inbox_search_field_matches(m.to_identifier, p_query)
              OR public.inbox_search_field_matches(m.cc, p_query)
              OR public.inbox_search_field_matches(m.body, p_query)
              OR public.inbox_search_field_matches(m.html_body, p_query)
            )
        )
        OR EXISTS (
          SELECT 1
          FROM public.inbox_thread_contacts itc
          JOIN public.contacts c ON c.id = itc.contact_id AND c.org_id = p_org_id
          LEFT JOIN public.companies co ON co.id = c.company_id AND co.org_id = p_org_id
          WHERE itc.thread_id = t.id
            AND (
              public.inbox_search_field_matches(c.name, p_query)
              OR public.inbox_search_field_matches(c.email, p_query)
              OR public.inbox_search_field_matches(co.name, p_query)
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
GRANT EXECUTE ON FUNCTION public.search_inbox_threads(uuid, uuid, text, text, integer, integer) TO service_role;
