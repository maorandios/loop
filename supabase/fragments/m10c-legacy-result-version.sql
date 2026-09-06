-- M10C-A: repair M10A v1 backfill before returned_with_file CHECK.
-- v1 return files start at version 2. Do not invent a version or rewrite result_action.

DO $m10c_v2_returned_with_file$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.handoff_transfers t
    JOIN public.handoffs h ON h.id = t.handoff_id
    WHERE h.flow_version = 2
      AND t.result_action = 'returned_with_file'
      AND t.result_version_number IS NULL
  ) THEN
    RAISE EXCEPTION 'm10c_v2_returned_with_file_missing_version'
      USING ERRCODE = 'P0001';
  END IF;
END
$m10c_v2_returned_with_file$;

UPDATE public.handoff_transfers AS t
SET result_version_number = derived.return_version
FROM public.handoffs AS h
JOIN LATERAL (
  SELECT pg_catalog.max(hv.version_number) AS return_version
  FROM public.handoff_versions AS hv
  WHERE hv.handoff_id = h.id
    AND hv.version_number >= 2
) AS derived ON derived.return_version IS NOT NULL
WHERE t.handoff_id = h.id
  AND t.parent_transfer_id IS NULL
  AND h.flow_version = 1
  AND t.result_action = 'returned_with_file'
  AND t.result_version_number IS NULL
  AND h.status IN ('returned', 'return_received');

DO $m10c_legacy_returned_with_file$
DECLARE
  v_leftover text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.right(h.id::text, 4), ', ' ORDER BY h.id)
  INTO v_leftover
  FROM public.handoff_transfers t
  JOIN public.handoffs h ON h.id = t.handoff_id
  WHERE h.flow_version = 1
    AND t.result_action = 'returned_with_file'
    AND t.result_version_number IS NULL;

  IF v_leftover IS NOT NULL THEN
    RAISE EXCEPTION 'm10c_legacy_returned_with_file_unmigratable'
      USING ERRCODE = 'P0001', DETAIL = v_leftover;
  END IF;
END
$m10c_legacy_returned_with_file$;
