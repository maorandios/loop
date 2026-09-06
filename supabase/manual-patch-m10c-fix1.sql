-- FileRelay Milestone 10C-A fix1
-- Apply once in the Supabase SQL Editor after manual-patch-m10c.sql.
-- Replaces schema-qualified NULLIF in result RPCs. NULLIF is a SQL construct, not a pg_catalog function.
-- Idempotent. Does not change data, constraints, or Storage.

BEGIN;

CREATE OR REPLACE FUNCTION public.finalize_transfer_result(
  p_handoff_id uuid,
  p_result_action text,
  p_result_note text,
  p_object_id uuid,
  p_file_size bigint,
  p_blake3 text,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_action text := pg_catalog.btrim(p_result_action);
  v_note text := NULLIF(pg_catalog.btrim(p_result_note), ''::text);
  v_hash text := pg_catalog.lower(pg_catalog.btrim(p_blake3));
  v_path text;
  v_object_size bigint;
  v_object_owner_id text;
  v_now timestamptz := pg_catalog.now();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL
     OR p_object_id IS NULL
     OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_note IS NOT NULL
     AND (
       pg_catalog.char_length(v_note) < 1
       OR pg_catalog.char_length(v_note) > 500
       OR v_note ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'finalize_transfer_result',
    private.command_fingerprint(
      p_handoff_id::text || E'\t' || COALESCE(v_action, '') || E'\t'
      || COALESCE(v_note, '') || E'\t' || p_object_id::text || E'\t'
      || p_file_size::text || E'\t' || v_hash
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'active'
     OR v_hop.to_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_action = 'returned_with_reply' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  PERFORM private.assert_result_matches_request(v_hop.requested_action, v_action);

  IF v_action IN ('rejected', 'returned_with_reply') AND v_note IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hop.pending_object_id IS DISTINCT FROM p_object_id
     OR v_hop.pending_version_number IS NULL
     OR v_hop.pending_storage_path IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  v_path := v_hop.workspace_id::text || '/' || p_handoff_id::text
    || '/v' || v_hop.pending_version_number::text || '/' || p_object_id::text;

  IF v_hop.pending_storage_path IS DISTINCT FROM v_path
     OR p_object_id::text IS DISTINCT FROM pg_catalog.split_part(v_path, '/', 4) THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

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

  IF v_object_size IS DISTINCT FROM p_file_size THEN
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
    p_handoff_id,
    v_hop.pending_version_number,
    v_path,
    p_file_size,
    v_hash,
    v_actor_id
  );

  IF v_action = 'approved' THEN
    UPDATE public.handoffs
    SET active_transfer_id = NULL,
        request_status = 'completed',
        closed_at = v_now
    WHERE id = p_handoff_id;

    UPDATE public.handoff_transfers
    SET status = 'closed',
        ended_at = v_now,
        result_action = 'approved',
        result_note = v_note,
        result_version_number = v_hop.pending_version_number,
        pending_object_id = NULL,
        pending_version_number = NULL,
        pending_storage_path = NULL,
        pending_upload_expires_at = NULL
    WHERE id = v_hop.transfer_id;
  ELSE
    UPDATE public.handoff_transfers
    SET status = 'returned_to_sender',
        result_action = v_action,
        result_note = v_note,
        result_version_number = v_hop.pending_version_number,
        pending_object_id = NULL,
        pending_version_number = NULL,
        pending_storage_path = NULL,
        pending_upload_expires_at = NULL
    WHERE id = v_hop.transfer_id;
  END IF;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    note,
    version_number,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    v_action,
    v_note,
    v_hop.pending_version_number,
    v_hop.handling_round
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', CASE WHEN v_action = 'approved' THEN 'completed' ELSE 'open' END,
    'transfer_status', CASE WHEN v_action = 'approved' THEN 'closed' ELSE 'returned_to_sender' END,
    'result_action', v_action,
    'version_number', v_hop.pending_version_number
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_transfer_result_without_file(
  p_handoff_id uuid,
  p_result_action text,
  p_result_note text,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_action text := pg_catalog.btrim(p_result_action);
  v_note text := NULLIF(pg_catalog.btrim(p_result_note), ''::text);
  v_now timestamptz := pg_catalog.now();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_note IS NOT NULL
     AND (
       pg_catalog.char_length(v_note) < 1
       OR pg_catalog.char_length(v_note) > 500
       OR v_note ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'submit_transfer_result_without_file',
    private.command_fingerprint(
      p_handoff_id::text || E'\t' || COALESCE(v_action, '') || E'\t' || COALESCE(v_note, '')
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'active'
     OR v_hop.to_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_action = 'returned_with_file' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  PERFORM private.assert_result_matches_request(v_hop.requested_action, v_action);

  IF v_action IN ('rejected', 'returned_with_reply') AND v_note IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hop.pending_object_id IS NOT NULL
     OR v_hop.pending_version_number IS NOT NULL
     OR v_hop.pending_storage_path IS NOT NULL
     OR v_hop.pending_upload_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'reservation_still_held' USING ERRCODE = 'P0001';
  END IF;

  IF v_action = 'approved' THEN
    UPDATE public.handoffs
    SET active_transfer_id = NULL,
        request_status = 'completed',
        closed_at = v_now
    WHERE id = p_handoff_id;

    UPDATE public.handoff_transfers
    SET status = 'closed',
        ended_at = v_now,
        result_action = 'approved',
        result_note = v_note,
        result_version_number = NULL
    WHERE id = v_hop.transfer_id;
  ELSE
    UPDATE public.handoff_transfers
    SET status = 'returned_to_sender',
        result_action = v_action,
        result_note = v_note,
        result_version_number = NULL
    WHERE id = v_hop.transfer_id;
  END IF;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    note,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    v_action,
    v_note,
    v_hop.handling_round
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', CASE WHEN v_action = 'approved' THEN 'completed' ELSE 'open' END,
    'transfer_status', CASE WHEN v_action = 'approved' THEN 'closed' ELSE 'returned_to_sender' END,
    'result_action', v_action
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_transfer_result_without_file(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_transfer_result_without_file(uuid, text, text, uuid) TO authenticated;

COMMIT;
