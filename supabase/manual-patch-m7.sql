-- FileRelay Milestone 7 patch
-- Idempotent. Paste and run in the Supabase SQL Editor.
-- Do not use the Supabase CLI.
-- Edit detection, modified/opened sync, and one v2 return round.
-- Does not enable installer or a second return loop.

BEGIN;

CREATE INDEX IF NOT EXISTS handoffs_sender_member_id_idx
  ON public.handoffs (sender_member_id);

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
      AND (
        v_version = 1
        OR (
          v_version = 2
          AND h.status IN ('returned', 'return_received')
        )
      )
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
      AND (
        (
          v_version = 1
          AND m.id = h.sender_member_id
          AND h.status = 'uploading'
        )
        OR (
          v_version = 2
          AND m.id = h.recipient_member_id
          AND h.status = 'returning'
        )
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION private.can_upload_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_upload_handoff_object(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_handoff_opened(handoff_id uuid)
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
  WHERE h.id = mark_handoff_opened.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'opened' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_opened.handoff_id,
      'status', 'opened'
    );
  END IF;

  IF v_status IN ('modified', 'returning', 'returned', 'return_received') THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_opened.handoff_id,
      'status', v_status
    );
  END IF;

  IF v_status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'opened'
  WHERE id = mark_handoff_opened.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_handoff_opened.handoff_id, v_recipient_id, 'opened');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_handoff_opened.handoff_id,
    'status', 'opened'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_handoff_modified(handoff_id uuid)
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
  WHERE h.id = mark_handoff_modified.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_modify_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'modified' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_modified.handoff_id,
      'status', 'modified'
    );
  END IF;

  IF v_status NOT IN ('opened', 'received') THEN
    RAISE EXCEPTION 'handoff_modify_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'modified'
  WHERE id = mark_handoff_modified.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_handoff_modified.handoff_id, v_recipient_id, 'modified');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_handoff_modified.handoff_id,
    'status', 'modified'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_handoff_unmodified(handoff_id uuid)
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
  WHERE h.id = mark_handoff_unmodified.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_unmodify_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'opened' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_unmodified.handoff_id,
      'status', 'opened'
    );
  END IF;

  IF v_status IS DISTINCT FROM 'modified' THEN
    RAISE EXCEPTION 'handoff_unmodify_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'opened'
  WHERE id = mark_handoff_unmodified.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_handoff_unmodified.handoff_id, v_recipient_id, 'restored');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_handoff_unmodified.handoff_id,
    'status', 'opened'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_handoff_return(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_workspace_id uuid;
  v_status text;
  v_object_id uuid := pg_catalog.gen_random_uuid();
  v_path text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  SELECT h.recipient_member_id, h.workspace_id, h.status
  INTO v_recipient_id, v_workspace_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = begin_handoff_return.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'modified' THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  v_path := v_workspace_id::text || '/' || begin_handoff_return.handoff_id::text
    || '/v2/' || v_object_id::text;

  UPDATE public.handoffs
  SET status = 'returning'
  WHERE id = begin_handoff_return.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (begin_handoff_return.handoff_id, v_recipient_id, 'returning');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', begin_handoff_return.handoff_id,
    'object_id', v_object_id,
    'storage_path', v_path,
    'status', 'returning'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_handoff_return_v2(
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
  v_recipient_id uuid;
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
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF file_size IS NULL OR file_size <= 0 OR file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.recipient_member_id, h.workspace_id, h.status
  INTO v_recipient_id, v_workspace_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = finalize_handoff_return_v2.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'returned'
     AND EXISTS (
       SELECT 1 FROM public.handoff_versions v
       WHERE v.handoff_id = finalize_handoff_return_v2.handoff_id
         AND v.version_number = 2
     ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  IF v_status IS DISTINCT FROM 'returning' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.handoff_versions v
    WHERE v.handoff_id = finalize_handoff_return_v2.handoff_id
      AND v.version_number = 2
  ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  v_path := v_workspace_id::text || '/' || finalize_handoff_return_v2.handoff_id::text
    || '/v2/' || object_id::text;

  SELECT (o.metadata->>'size')::bigint, o.owner_id
  INTO v_object_size, v_object_owner_id
  FROM storage.objects o
  WHERE o.bucket_id = 'filerelay'
    AND o.name = v_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_object_missing' USING ERRCODE = 'P0001';
  END IF;

  IF v_object_owner_id IS DISTINCT FROM v_user_id::text THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
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
    finalize_handoff_return_v2.handoff_id,
    2,
    v_path,
    file_size,
    v_hash,
    v_recipient_id
  );

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (finalize_handoff_return_v2.handoff_id, v_recipient_id, 'returned');

  UPDATE public.handoffs
  SET status = 'returned'
  WHERE id = finalize_handoff_return_v2.handoff_id;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', finalize_handoff_return_v2.handoff_id,
    'status', 'returned'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_handoff_return(handoff_id uuid)
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
  WHERE h.id = fail_handoff_return.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'returning' THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'modified'
  WHERE id = fail_handoff_return.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (fail_handoff_return.handoff_id, v_recipient_id, 'return_failed');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', fail_handoff_return.handoff_id,
    'status', 'modified'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_return_received(handoff_id uuid)
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
  WHERE h.id = mark_return_received.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_receive_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'return_received' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_return_received.handoff_id,
      'status', 'return_received'
    );
  END IF;

  IF v_status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'handoff_return_receive_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'return_received'
  WHERE id = mark_return_received.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_return_received.handoff_id, v_sender_id, 'return_received');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_return_received.handoff_id,
    'status', 'return_received'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_handoff_opened(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_handoff_modified(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_handoff_unmodified(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.begin_handoff_return(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finalize_handoff_return_v2(uuid, uuid, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fail_handoff_return(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_return_received(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.mark_handoff_opened(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_handoff_modified(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_handoff_unmodified(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.begin_handoff_return(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_handoff_return_v2(uuid, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_handoff_return(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_return_received(uuid) TO authenticated;

COMMIT;
