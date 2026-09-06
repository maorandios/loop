CREATE OR REPLACE FUNCTION private.assert_result_matches_request(
  p_requested_action text,
  p_result_action text
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_requested_action = 'approval'
     AND p_result_action IN ('approved', 'rejected') THEN
    RETURN;
  END IF;

  IF p_requested_action = 'review'
     AND p_result_action IN ('review_completed', 'rejected') THEN
    RETURN;
  END IF;

  IF p_requested_action = 'update'
     AND p_result_action IN ('returned_with_file', 'returned_with_reply', 'rejected') THEN
    RETURN;
  END IF;

  IF p_requested_action = 'file_request'
     AND p_result_action IN ('returned_with_file', 'rejected') THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'result_action_mismatch' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_v2_open_root(p_handoff_id uuid)
RETURNS TABLE (
  workspace_id uuid,
  sender_member_id uuid,
  transfer_id uuid,
  transfer_status text,
  from_member_id uuid,
  to_member_id uuid,
  requested_action text,
  handling_round integer,
  result_action text,
  result_note text,
  result_version_number integer,
  pending_object_id uuid,
  pending_version_number integer,
  pending_storage_path text,
  pending_upload_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace uuid;
  v_sender uuid;
  v_recipient uuid;
  v_flow smallint;
  v_request text;
  v_active uuid;
  v_parent uuid;
BEGIN
  IF p_handoff_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.workspace_id, h.sender_member_id, h.recipient_member_id,
         h.flow_version, h.request_status, h.active_transfer_id
  INTO v_workspace, v_sender, v_recipient, v_flow, v_request, v_active
  FROM public.handoffs h
  WHERE h.id = p_handoff_id
  FOR UPDATE OF h;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  IF v_flow IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  IF v_request = 'completed' THEN
    RAISE EXCEPTION 'handoff_already_completed' USING ERRCODE = '22023';
  END IF;

  IF v_request = 'cancelled' THEN
    RAISE EXCEPTION 'handoff_already_cancelled' USING ERRCODE = '22023';
  END IF;

  IF v_request IS DISTINCT FROM 'open' OR v_active IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_members m
    WHERE m.user_id = auth.uid()
      AND m.id IN (v_sender, v_recipient)
  ) THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  SELECT t.id, t.status, t.from_member_id, t.to_member_id, t.requested_action,
         t.handling_round, t.result_action, t.result_note, t.result_version_number,
         t.pending_object_id, t.pending_version_number, t.pending_storage_path,
         t.pending_upload_expires_at, t.parent_transfer_id
  INTO transfer_id, transfer_status, from_member_id, to_member_id, requested_action,
       handling_round, result_action, result_note, result_version_number,
       pending_object_id, pending_version_number, pending_storage_path,
       pending_upload_expires_at, v_parent
  FROM public.handoff_transfers t
  WHERE t.id = v_active
    AND t.handoff_id = p_handoff_id
  FOR UPDATE OF t;

  IF transfer_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  IF v_parent IS NOT NULL THEN
    RAISE EXCEPTION 'not_root_transfer' USING ERRCODE = '22023';
  END IF;

  workspace_id := v_workspace;
  sender_member_id := v_sender;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_root_transfer_opened(
  p_handoff_id uuid,
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
  v_event_id uuid;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'mark_root_transfer_opened',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.requested_action = 'file_request'
     AND v_hop.transfer_status = 'active' THEN
    RAISE EXCEPTION 'file_request_not_yet_supplied' USING ERRCODE = '22023';
  END IF;

  IF v_hop.transfer_status = 'active'
     AND v_hop.to_member_id = v_actor_id THEN
    NULL;
  ELSIF v_hop.transfer_status = 'returned_to_sender'
     AND v_hop.from_member_id = v_actor_id
     AND v_hop.result_version_number IS NOT NULL THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  SELECT e.id
  INTO v_event_id
  FROM public.handoff_events e
  WHERE e.transfer_id = v_hop.transfer_id
    AND e.event_type = 'opened'
    AND e.handling_round = v_hop.handling_round;

  IF v_event_id IS NULL THEN
    BEGIN
      INSERT INTO public.handoff_events (
        handoff_id,
        actor_member_id,
        transfer_id,
        client_request_id,
        event_type,
        handling_round
      )
      VALUES (
        p_handoff_id,
        v_actor_id,
        v_hop.transfer_id,
        p_client_request_id,
        'opened',
        v_hop.handling_round
      )
      RETURNING id INTO v_event_id;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT e.id
        INTO v_event_id
        FROM public.handoff_events e
        WHERE e.transfer_id = v_hop.transfer_id
          AND e.event_type = 'opened'
          AND e.handling_round = v_hop.handling_round;
    END;
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'handling_round', v_hop.handling_round,
    'event_id', v_event_id
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_transfer_result_upload(
  p_handoff_id uuid,
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
  v_object_id uuid;
  v_version integer;
  v_path text;
  v_expires timestamptz;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'begin_transfer_result_upload',
    private.command_fingerprint(p_handoff_id::text)
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
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  v_expires := pg_catalog.now() + interval '60 minutes';

  IF v_hop.pending_object_id IS NOT NULL
     AND v_hop.pending_version_number IS NOT NULL
     AND v_hop.pending_storage_path IS NOT NULL
     AND v_hop.pending_upload_expires_at IS NOT NULL THEN
    UPDATE public.handoff_transfers
    SET pending_upload_expires_at = v_expires
    WHERE id = v_hop.transfer_id
      AND pending_object_id = v_hop.pending_object_id
      AND pending_version_number = v_hop.pending_version_number
      AND pending_storage_path = v_hop.pending_storage_path;

    v_result := pg_catalog.jsonb_build_object(
      'object_id', v_hop.pending_object_id,
      'version_number', v_hop.pending_version_number,
      'storage_path', v_hop.pending_storage_path,
      'pending_upload_expires_at', v_expires
    );
    PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
    RETURN v_result;
  END IF;

  v_object_id := pg_catalog.gen_random_uuid();
  SELECT COALESCE(pg_catalog.max(hv.version_number), 0) + 1
  INTO v_version
  FROM public.handoff_versions hv
  WHERE hv.handoff_id = p_handoff_id;

  IF v_version IS NULL OR v_version < 1 OR v_version > 1000 THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  v_path := v_hop.workspace_id::text || '/' || p_handoff_id::text
    || '/v' || v_version::text || '/' || v_object_id::text;

  UPDATE public.handoff_transfers
  SET pending_object_id = v_object_id,
      pending_version_number = v_version,
      pending_storage_path = v_path,
      pending_upload_expires_at = v_expires
  WHERE id = v_hop.transfer_id
    AND pending_object_id IS NULL
    AND pending_version_number IS NULL
    AND pending_storage_path IS NULL
    AND pending_upload_expires_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_still_held' USING ERRCODE = 'P0001';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'object_id', v_object_id,
    'version_number', v_version,
    'storage_path', v_path,
    'pending_upload_expires_at', v_expires
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_transfer_upload_reservation(
  p_handoff_id uuid,
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
  v_expires timestamptz;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'renew_transfer_upload_reservation',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF NOT (
       (v_hop.transfer_status = 'preparing' AND v_hop.from_member_id = v_actor_id)
       OR (v_hop.transfer_status = 'active' AND v_hop.to_member_id = v_actor_id)
     ) THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.pending_object_id IS NULL
     OR v_hop.pending_version_number IS NULL
     OR v_hop.pending_storage_path IS NULL
     OR v_hop.pending_upload_expires_at IS NULL THEN
    RAISE EXCEPTION 'reservation_missing' USING ERRCODE = 'P0001';
  END IF;

  v_expires := pg_catalog.now() + interval '60 minutes';

  UPDATE public.handoff_transfers
  SET pending_upload_expires_at = v_expires
  WHERE id = v_hop.transfer_id
    AND pending_object_id = v_hop.pending_object_id
    AND pending_version_number = v_hop.pending_version_number
    AND pending_storage_path = v_hop.pending_storage_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_missing' USING ERRCODE = 'P0001';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'object_id', v_hop.pending_object_id,
    'version_number', v_hop.pending_version_number,
    'storage_path', v_hop.pending_storage_path,
    'pending_upload_expires_at', v_expires
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

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
  v_file_name text;
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

  IF v_hop.requested_action = 'file_request' THEN
    RAISE EXCEPTION 'result_action_mismatch' USING ERRCODE = '22023';
  END IF;

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

  SELECT h.original_filename
  INTO v_file_name
  FROM public.handoffs h
  WHERE h.id = p_handoff_id;

  v_path := private.assert_reserved_upload_matches(
    v_hop.workspace_id,
    p_handoff_id,
    v_user_id,
    p_object_id,
    p_file_size,
    v_hop.pending_object_id,
    v_hop.pending_version_number,
    v_hop.pending_storage_path,
    v_hash
  );

  PERFORM private.insert_handoff_version(
    p_handoff_id,
    v_hop.pending_version_number,
    v_path,
    p_file_size,
    v_hash,
    v_actor_id,
    v_file_name
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

CREATE OR REPLACE FUNCTION public.abort_transfer_result_upload(
  p_handoff_id uuid,
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
  v_object_exists boolean;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'abort_transfer_result_upload',
    private.command_fingerprint(p_handoff_id::text)
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
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.pending_object_id IS NULL
     AND v_hop.pending_version_number IS NULL
     AND v_hop.pending_storage_path IS NULL
     AND v_hop.pending_upload_expires_at IS NULL THEN
    v_result := pg_catalog.jsonb_build_object('transfer_status', 'active');
    PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
    RETURN v_result;
  END IF;

  IF v_hop.pending_storage_path IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM storage.objects o
      WHERE o.bucket_id = 'filerelay'
        AND o.name = v_hop.pending_storage_path
    )
    INTO v_object_exists;

    IF v_object_exists THEN
      RAISE EXCEPTION 'handoff_abort_cleanup_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.handoff_transfers
  SET pending_object_id = NULL,
      pending_version_number = NULL,
      pending_storage_path = NULL,
      pending_upload_expires_at = NULL
  WHERE id = v_hop.transfer_id;

  v_result := pg_catalog.jsonb_build_object('transfer_status', 'active');
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_root_transfer_result(
  p_handoff_id uuid,
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
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'accept_root_transfer_result',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'returned_to_sender'
     OR v_hop.from_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.requested_action = 'file_request'
     AND (
       v_hop.result_action IS DISTINCT FROM 'returned_with_file'
       OR v_hop.result_version_number IS NULL
     ) THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET active_transfer_id = NULL,
      request_status = 'completed',
      closed_at = v_now
  WHERE id = p_handoff_id;

  UPDATE public.handoff_transfers
  SET status = 'closed',
      ended_at = v_now
  WHERE id = v_hop.transfer_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    'completed',
    v_hop.handling_round
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'completed',
    'transfer_status', 'closed'
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_root_transfer_revision(
  p_handoff_id uuid,
  p_note text,
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
  v_note text := pg_catalog.btrim(p_note);
  v_next_round integer;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_revision_failed' USING ERRCODE = '22023';
  END IF;

  IF v_note IS NULL
     OR pg_catalog.char_length(v_note) < 1
     OR pg_catalog.char_length(v_note) > 500
     OR v_note ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'revision_note_required' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_revision_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'request_root_transfer_revision',
    private.command_fingerprint(p_handoff_id::text || E'\t' || v_note)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'returned_to_sender'
     OR v_hop.from_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_revision_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.handling_round >= 1000 THEN
    RAISE EXCEPTION 'handling_round_limit' USING ERRCODE = '22023';
  END IF;

  v_next_round := v_hop.handling_round + 1;

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
    'revision_requested',
    v_note,
    v_hop.handling_round
  );

  UPDATE public.handoff_transfers
  SET status = 'active',
      handling_round = v_next_round,
      result_action = NULL,
      result_note = NULL,
      result_version_number = NULL
  WHERE id = v_hop.transfer_id;

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'open',
    'transfer_status', 'active',
    'handling_round', v_next_round
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_root_handoff_v2(
  p_handoff_id uuid,
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
  v_object_exists boolean;
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
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'cancel_root_handoff_v2',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.sender_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.pending_storage_path IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM storage.objects o
      WHERE o.bucket_id = 'filerelay'
        AND o.name = v_hop.pending_storage_path
    )
    INTO v_object_exists;

    IF v_object_exists THEN
      RAISE EXCEPTION 'handoff_abort_cleanup_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.handoffs
  SET active_transfer_id = NULL,
      request_status = 'cancelled',
      cancelled_at = v_now
  WHERE id = p_handoff_id;

  UPDATE public.handoff_transfers
  SET status = 'closed',
      ended_at = v_now,
      pending_object_id = NULL,
      pending_version_number = NULL,
      pending_storage_path = NULL,
      pending_upload_expires_at = NULL
  WHERE id = v_hop.transfer_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    'cancelled'
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'cancelled',
    'transfer_status', 'closed'
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;
