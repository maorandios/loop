CREATE OR REPLACE FUNCTION public.create_file_request_v2(
  p_recipient_member_id uuid,
  p_instruction text,
  p_due_on date,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_instruction text := pg_catalog.btrim(p_instruction);
  v_sender_id uuid;
  v_workspace_id uuid;
  v_recipient_workspace uuid;
  v_handoff_id uuid := pg_catalog.gen_random_uuid();
  v_transfer_id uuid := pg_catalog.gen_random_uuid();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF v_instruction IS NULL
     OR pg_catalog.char_length(v_instruction) < 1
     OR pg_catalog.char_length(v_instruction) > 280
     OR v_instruction ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'instruction_required' USING ERRCODE = '22023';
  END IF;

  IF p_recipient_member_id IS NULL OR p_client_request_id IS NULL THEN
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
  WHERE m.id = p_recipient_member_id;

  IF v_recipient_workspace IS NULL
     OR v_recipient_workspace IS DISTINCT FROM v_workspace_id
     OR p_recipient_member_id = v_sender_id THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_sender_id,
    p_client_request_id,
    'create_file_request_v2',
    private.command_fingerprint(
      p_recipient_member_id::text || E'\t' || v_instruction || E'\t'
      || COALESCE(p_due_on::text, '')
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  INSERT INTO public.handoffs (
    id,
    workspace_id,
    sender_member_id,
    recipient_member_id,
    original_filename,
    instruction,
    due_on,
    status,
    flow_version,
    request_status,
    active_transfer_id
  )
  VALUES (
    v_handoff_id,
    v_workspace_id,
    v_sender_id,
    p_recipient_member_id,
    NULL,
    v_instruction,
    p_due_on,
    NULL,
    2,
    'open',
    v_transfer_id
  );

  INSERT INTO public.handoff_transfers (
    id,
    handoff_id,
    workspace_id,
    parent_transfer_id,
    from_member_id,
    to_member_id,
    requested_action,
    instruction,
    due_on,
    status
  )
  VALUES (
    v_transfer_id,
    v_handoff_id,
    v_workspace_id,
    NULL,
    v_sender_id,
    p_recipient_member_id,
    'file_request',
    v_instruction,
    p_due_on,
    'active'
  );

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type
  )
  VALUES (
    v_handoff_id,
    v_sender_id,
    v_transfer_id,
    p_client_request_id,
    'created'
  );

  v_result := pg_catalog.jsonb_build_object(
    'handoff_id', v_handoff_id,
    'transfer_id', v_transfer_id
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, v_handoff_id, v_transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_file_request_result(
  p_handoff_id uuid,
  p_file_name text,
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
  v_name text := NULLIF(pg_catalog.btrim(p_file_name), ''::text);
  v_hash text := pg_catalog.lower(pg_catalog.btrim(p_blake3));
  v_path text;
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

  PERFORM private.assert_safe_file_name(v_name);

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
    'finalize_file_request_result',
    private.command_fingerprint(
      p_handoff_id::text || E'\t' || v_name || E'\t' || p_object_id::text || E'\t'
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

  IF v_hop.requested_action IS DISTINCT FROM 'file_request' THEN
    RAISE EXCEPTION 'result_action_mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_hop.transfer_status IS DISTINCT FROM 'active'
     OR v_hop.to_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

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
    v_name
  );

  UPDATE public.handoff_transfers
  SET status = 'returned_to_sender',
      result_action = 'returned_with_file',
      result_note = NULL,
      result_version_number = v_hop.pending_version_number,
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
    event_type,
    version_number,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    'returned_with_file',
    v_hop.pending_version_number,
    v_hop.handling_round
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'open',
    'transfer_status', 'returned_to_sender',
    'result_action', 'returned_with_file',
    'version_number', v_hop.pending_version_number
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;
