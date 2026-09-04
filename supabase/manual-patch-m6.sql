-- FileRelay Milestone 6 patch
-- Idempotent. Paste and run in the Supabase SQL Editor.
-- Do not use the Supabase CLI.
-- One-way v1 transfer only. Does not enable v2, watcher, or returns.

BEGIN;

CREATE INDEX IF NOT EXISTS handoffs_workspace_id_idx
  ON public.handoffs (workspace_id);
CREATE INDEX IF NOT EXISTS handoffs_recipient_member_id_idx
  ON public.handoffs (recipient_member_id);

CREATE OR REPLACE FUNCTION private.handoff_status_visible_to_recipient(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_status IN (
    'sent',
    'received',
    'opened',
    'modified',
    'returning',
    'returned',
    'return_received'
  );
$$;

REVOKE ALL ON FUNCTION private.handoff_status_visible_to_recipient(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.handoff_status_visible_to_recipient(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.can_read_handoff_object(object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_handoff_id uuid;
  v_version integer;
BEGIN
  SELECT p.workspace_id, p.handoff_id, p.version_number
  INTO v_workspace_id, v_handoff_id, v_version
  FROM private.try_parse_handoff_object(object_name) AS p;

  IF v_workspace_id IS NULL OR v_handoff_id IS NULL OR v_version IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.handoffs h
    JOIN public.handoff_versions hv
      ON hv.handoff_id = h.id
    WHERE h.id = v_handoff_id
      AND h.workspace_id = v_workspace_id
      AND private.is_handoff_participant(h.id)
      AND private.handoff_status_visible_to_recipient(h.status)
      AND hv.handoff_id = v_handoff_id
      AND hv.version_number = v_version
      AND hv.storage_path = object_name
  );
END;
$$;

REVOKE ALL ON FUNCTION private.can_read_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_read_handoff_object(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.can_upload_handoff_object(object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_handoff_id uuid;
  v_version integer;
BEGIN
  SELECT p.workspace_id, p.handoff_id, p.version_number
  INTO v_workspace_id, v_handoff_id, v_version
  FROM private.try_parse_handoff_object(object_name) AS p;

  IF v_workspace_id IS NULL OR v_handoff_id IS NULL OR v_version IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.handoffs h
    JOIN public.workspace_members m ON m.user_id = auth.uid()
    WHERE h.id = v_handoff_id
      AND h.workspace_id = v_workspace_id
      AND v_version = 1
      AND m.id = h.sender_member_id
      AND h.status = 'uploading'
  );
END;
$$;

REVOKE ALL ON FUNCTION private.can_upload_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_upload_handoff_object(text)
  TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.handoffs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoff_versions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoff_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.handoffs TO authenticated;
GRANT SELECT ON public.handoff_versions TO authenticated;
GRANT SELECT ON public.handoff_events TO authenticated;

DROP POLICY IF EXISTS handoffs_insert_sender ON public.handoffs;
DROP POLICY IF EXISTS handoffs_update_member ON public.handoffs;
DROP POLICY IF EXISTS handoffs_update_participant ON public.handoffs;
DROP POLICY IF EXISTS handoff_versions_insert_member ON public.handoff_versions;
DROP POLICY IF EXISTS handoff_events_insert_member ON public.handoff_events;

DROP POLICY IF EXISTS handoffs_select_member ON public.handoffs;
DROP POLICY IF EXISTS handoffs_select_participant ON public.handoffs;
CREATE POLICY handoffs_select_participant
  ON public.handoffs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.workspace_members sender
      WHERE sender.id = handoffs.sender_member_id
        AND sender.user_id = auth.uid()
    )
    OR (
      EXISTS (
        SELECT 1
        FROM public.workspace_members recipient
        WHERE recipient.id = handoffs.recipient_member_id
          AND recipient.user_id = auth.uid()
      )
      AND private.handoff_status_visible_to_recipient(handoffs.status)
    )
  );

DROP POLICY IF EXISTS handoff_versions_select_member ON public.handoff_versions;
DROP POLICY IF EXISTS handoff_versions_select_participant ON public.handoff_versions;
CREATE POLICY handoff_versions_select_participant
  ON public.handoff_versions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.handoffs h
      JOIN public.workspace_members sender ON sender.id = h.sender_member_id
      WHERE h.id = handoff_versions.handoff_id
        AND sender.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.handoffs h
      JOIN public.workspace_members recipient ON recipient.id = h.recipient_member_id
      WHERE h.id = handoff_versions.handoff_id
        AND recipient.user_id = auth.uid()
        AND private.handoff_status_visible_to_recipient(h.status)
    )
  );

DROP POLICY IF EXISTS handoff_events_select_member ON public.handoff_events;
DROP POLICY IF EXISTS handoff_events_select_participant ON public.handoff_events;
CREATE POLICY handoff_events_select_participant
  ON public.handoff_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.handoffs h
      JOIN public.workspace_members sender ON sender.id = h.sender_member_id
      WHERE h.id = handoff_events.handoff_id
        AND sender.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.handoffs h
      JOIN public.workspace_members recipient ON recipient.id = h.recipient_member_id
      WHERE h.id = handoff_events.handoff_id
        AND recipient.user_id = auth.uid()
        AND private.handoff_status_visible_to_recipient(h.status)
    )
  );

CREATE OR REPLACE FUNCTION public.create_handoff(
  recipient_member_id uuid,
  original_filename text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_name text := pg_catalog.btrim(original_filename);
  v_sender_id uuid;
  v_workspace_id uuid;
  v_recipient_workspace uuid;
  v_handoff_id uuid;
  v_object_id uuid := pg_catalog.gen_random_uuid();
  v_path text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF v_name IS NULL
     OR pg_catalog.char_length(v_name) = 0
     OR pg_catalog.char_length(v_name) > 255
     OR v_name ~ '[\\/]'
     OR v_name LIKE '%..%'
     OR original_filename ~ '[[:cntrl:]]'
     OR original_filename ~ '[. ]$'
     OR pg_catalog.upper(
          CASE
            WHEN v_name ~ '\.[^.]+$' THEN pg_catalog.regexp_replace(v_name, '\.[^.]+$', '')
            ELSE v_name
          END
        ) IN (
          'CON', 'PRN', 'AUX', 'NUL',
          'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
          'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
        )
  THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  IF recipient_member_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id, m.workspace_id
  INTO v_sender_id, v_workspace_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  SELECT m.workspace_id
  INTO v_recipient_workspace
  FROM public.workspace_members m
  WHERE m.id = recipient_member_id;

  IF v_recipient_workspace IS NULL
     OR v_recipient_workspace IS DISTINCT FROM v_workspace_id
     OR recipient_member_id = v_sender_id THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.handoffs (
    workspace_id,
    sender_member_id,
    recipient_member_id,
    original_filename,
    status
  )
  VALUES (
    v_workspace_id,
    v_sender_id,
    recipient_member_id,
    v_name,
    'uploading'
  )
  RETURNING id INTO v_handoff_id;

  v_path := v_workspace_id::text || '/' || v_handoff_id::text || '/v1/' || v_object_id::text;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', v_handoff_id,
    'object_id', v_object_id,
    'storage_path', v_path,
    'workspace_id', v_workspace_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_handoff_v1(
  handoff_id uuid,
  object_id uuid,
  file_size bigint,
  blake3 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sender_id uuid;
  v_workspace_id uuid;
  v_status text;
  v_path text;
  v_object_size bigint;
  v_object_owner_id text;
  v_hash text := pg_catalog.lower(pg_catalog.btrim(blake3));
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF handoff_id IS NULL OR object_id IS NULL THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF file_size IS NULL OR file_size <= 0 OR file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.sender_member_id, h.workspace_id, h.status
  INTO v_sender_id, v_workspace_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.sender_member_id
  WHERE h.id = finalize_handoff_v1.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'sent'
     AND EXISTS (
       SELECT 1 FROM public.handoff_versions v
       WHERE v.handoff_id = finalize_handoff_v1.handoff_id
         AND v.version_number = 1
     ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  IF v_status IS DISTINCT FROM 'uploading' THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.handoff_versions v
    WHERE v.handoff_id = finalize_handoff_v1.handoff_id
      AND v.version_number = 1
  ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  v_path := v_workspace_id::text || '/' || finalize_handoff_v1.handoff_id::text
    || '/v1/' || object_id::text;

  SELECT (o.metadata->>'size')::bigint, o.owner_id
  INTO v_object_size, v_object_owner_id
  FROM storage.objects o
  WHERE o.bucket_id = 'filerelay'
    AND o.name = v_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_object_missing' USING ERRCODE = 'P0001';
  END IF;

  IF v_object_owner_id IS DISTINCT FROM v_user_id::text THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_object_size IS DISTINCT FROM file_size THEN
    RAISE EXCEPTION 'handoff_object_size_mismatch' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.handoff_versions (
    handoff_id,
    version_number,
    storage_path,
    file_size,
    blake3,
    uploaded_by_member_id
  )
  VALUES (
    finalize_handoff_v1.handoff_id,
    1,
    v_path,
    file_size,
    v_hash,
    v_sender_id
  );

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (finalize_handoff_v1.handoff_id, v_sender_id, 'finalized');

  UPDATE public.handoffs
  SET status = 'sent'
  WHERE id = finalize_handoff_v1.handoff_id;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', finalize_handoff_v1.handoff_id,
    'status', 'sent'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_handoff(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sender_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  SELECT h.sender_member_id, h.status
  INTO v_sender_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.sender_member_id
  WHERE h.id = fail_handoff.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'uploading' THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'failed'
  WHERE id = fail_handoff.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (fail_handoff.handoff_id, v_sender_id, 'failed');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', fail_handoff.handoff_id,
    'status', 'failed'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_handoff_received(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  SELECT h.recipient_member_id, h.status
  INTO v_recipient_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = mark_handoff_received.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_receive_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'received' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_received.handoff_id,
      'status', 'received'
    );
  END IF;

  IF v_status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'handoff_receive_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'received'
  WHERE id = mark_handoff_received.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_handoff_received.handoff_id, v_recipient_id, 'received');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_handoff_received.handoff_id,
    'status', 'received'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_handoff(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finalize_handoff_v1(uuid, uuid, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fail_handoff(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_handoff_received(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_handoff(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_handoff_v1(uuid, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_handoff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_handoff_received(uuid) TO authenticated;

COMMIT;
