-- Restore orphan-thread guard on empty/null inbox list queries.
-- 20260722140000 dropped the message EXISTS check on the fast path, surfacing
-- threads with zero inbox_messages. Keep paginated fast path; hide orphans again.

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
  WITH search_terms AS (
    SELECT
      NULLIF(BTRIM(COALESCE(p_query, '')), '') AS raw,
      public.normalize_inbox_search_text(BTRIM(COALESCE(p_query, ''))) AS normalized
  ),
  visible_threads AS (
    SELECT t.*
    FROM public.inbox_threads t
    CROSS JOIN search_terms sq
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
        sq.raw IS NULL
        OR (
          EXISTS (
            SELECT 1
            FROM public.inbox_messages m
            WHERE m.thread_id = t.id
          )
          AND (
            public.inbox_search_metadata_matches(t.subject, sq.raw, sq.normalized)
            OR public.inbox_search_metadata_matches(t.from_address, sq.raw, sq.normalized)
            OR public.inbox_search_metadata_matches(t.mailbox_address, sq.raw, sq.normalized)
            OR EXISTS (
              SELECT 1 FROM public.imap_accounts ia
              WHERE ia.id = t.imap_account_id
                AND ia.org_id = p_org_id
                AND (
                  public.inbox_search_metadata_matches(ia.email, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(ia.label, sq.raw, sq.normalized)
                )
            )
            OR EXISTS (
              SELECT 1
              FROM public.inbox_messages m
              WHERE m.thread_id = t.id
                AND (
                  public.inbox_search_metadata_matches(m.from_identifier, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(m.to_identifier, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(m.cc, sq.raw, sq.normalized)
                  OR public.inbox_search_body_matches(m.body, sq.raw)
                  OR public.inbox_search_body_matches(m.html_body, sq.raw)
                )
            )
            OR EXISTS (
              SELECT 1
              FROM public.inbox_thread_contacts itc
              JOIN public.contacts c ON c.id = itc.contact_id AND c.org_id = p_org_id
              LEFT JOIN public.companies co ON co.id = c.company_id AND co.org_id = p_org_id
              WHERE itc.thread_id = t.id
                AND (
                  public.inbox_search_metadata_matches(c.name, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(c.email, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(co.name, sq.raw, sq.normalized)
                )
            )
          )
        )
      )
    ORDER BY t.last_message_at DESC, t.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
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
    CASE
      WHEN sq.raw IS NULL THEN 0::bigint
      ELSE COALESCE(counts.message_count, 0)::bigint
    END AS message_count
  FROM visible_threads vt
  CROSS JOIN search_terms sq
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('user_id', a.user_id) ORDER BY a.assigned_at) AS items
    FROM public.inbox_thread_assignments a
    WHERE a.thread_id = vt.id
  ) assignments ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS message_count
    FROM public.inbox_messages m
    WHERE m.thread_id = vt.id
  ) counts ON sq.raw IS NOT NULL
  ORDER BY vt.last_message_at DESC, vt.id DESC;
$$;

GRANT EXECUTE ON FUNCTION public.search_inbox_threads(uuid, uuid, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_inbox_threads(uuid, uuid, text, text, integer, integer) TO service_role;
