import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const functions = read("supabase/fragments/m10c-functions.sql").trimEnd();
const legacyResultVersion = read("supabase/fragments/m10c-legacy-result-version.sql").trimEnd();
const setup = read("supabase/manual-setup.sql");

function functionBody(sql, signatureStart) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signatureStart}`);
  if (start === -1) {
    throw new Error(`missing ${signatureStart}`);
  }
  const end = sql.indexOf("$$;", start);
  if (end === -1) {
    throw new Error(`unterminated ${signatureStart}`);
  }
  return sql.slice(start, end + 3);
}

const canDelete = functionBody(setup, "private.can_delete_reserved_handoff_object(object_name text)");

const grants = `REVOKE ALL ON FUNCTION private.assert_result_matches_request(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_v2_open_root(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_root_transfer_opened(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_transfer_result_upload(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_transfer_upload_reservation(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_transfer_result_without_file(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abort_transfer_result_upload(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_root_transfer_result(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_root_transfer_revision(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_root_handoff_v2(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_root_transfer_opened(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.begin_transfer_result_upload(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.renew_transfer_upload_reservation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_transfer_result_without_file(uuid, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.abort_transfer_result_upload(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_root_transfer_result(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_root_transfer_revision(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_root_handoff_v2(uuid, uuid) TO authenticated;`;

const fnStart = "-- M10C-FUNCTIONS-START";
const fnEnd = "-- M10C-FUNCTIONS-END";
const grantStart = "-- M10C-GRANTS-START";
const grantEnd = "-- M10C-GRANTS-END";
const legacyStart = "-- M10C-LEGACY-START";
const legacyEnd = "-- M10C-LEGACY-END";

function replaceMarker(source, start, end, body) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (startAt === -1 || endAt === -1 || endAt < startAt) {
    throw new Error(`missing markers ${start} / ${end}`);
  }
  return `${source.slice(0, startAt + start.length)}\n${body}\n${source.slice(endAt)}`;
}

let nextSetup = setup;
if (!setup.includes(fnStart)) {
  const insertAt = setup.indexOf("REVOKE ALL ON FUNCTION public.create_workspace(text, uuid) FROM PUBLIC, anon;");
  if (insertAt === -1) {
    throw new Error("missing create_workspace revoke anchor");
  }
  nextSetup = `${setup.slice(0, insertAt)}${fnStart}\n${functions}\n${fnEnd}\n\n${setup.slice(insertAt)}`;
} else {
  nextSetup = replaceMarker(nextSetup, fnStart, fnEnd, functions);
}

if (!nextSetup.includes(legacyStart)) {
  const legacyAt = nextSetup.indexOf("CREATE TABLE IF NOT EXISTS public.handoff_command_receipts");
  if (legacyAt === -1) {
    throw new Error("missing handoff_command_receipts anchor");
  }
  nextSetup = `${nextSetup.slice(0, legacyAt)}${legacyStart}\n${legacyResultVersion}\n${legacyEnd}\n\n${nextSetup.slice(legacyAt)}`;
} else {
  nextSetup = replaceMarker(nextSetup, legacyStart, legacyEnd, legacyResultVersion);
}

if (!nextSetup.includes(grantStart)) {
  const grantAt = nextSetup.indexOf(
    "GRANT EXECUTE ON FUNCTION public.send_transfer_reminder(uuid, uuid) TO authenticated;",
  );
  if (grantAt === -1) {
    throw new Error("missing send_transfer_reminder grant anchor");
  }
  const grantLineEnd = nextSetup.indexOf("\n", grantAt);
  nextSetup = `${nextSetup.slice(0, grantLineEnd + 1)}${grantStart}\n${grants}\n${grantEnd}\n${nextSetup.slice(grantLineEnd + 1)}`;
} else {
  nextSetup = replaceMarker(nextSetup, grantStart, grantEnd, grants);
}

writeFileSync(path.join(root, "supabase/manual-setup.sql"), nextSetup);

const patch = `-- FileRelay Milestone 10C-A patch
-- Apply once in the Supabase SQL Editor on a database that already has Milestone 10A.
-- New projects should run supabase/manual-setup.sql instead.
-- Idempotent and safe to re-run. Do not use the Supabase CLI.
-- Do not rewrite handoff_versions, storage paths, or existing event rows.
-- Does not issue a SQL delete against Storage objects.

BEGIN;

ALTER TABLE public.handoff_transfers
  ADD COLUMN IF NOT EXISTS handling_round integer;

UPDATE public.handoff_transfers
SET handling_round = 1
WHERE handling_round IS NULL;

ALTER TABLE public.handoff_transfers
  ALTER COLUMN handling_round SET DEFAULT 1;
ALTER TABLE public.handoff_transfers
  ALTER COLUMN handling_round SET NOT NULL;

DO $m10c_handling_round$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_handling_round_check'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_handling_round_check
      CHECK (handling_round BETWEEN 1 AND 1000);
  END IF;
END
$m10c_handling_round$;

ALTER TABLE public.handoff_events
  ADD COLUMN IF NOT EXISTS handling_round integer;

DO $m10c_event_round$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_events_handling_round_check'
  ) THEN
    ALTER TABLE public.handoff_events
      ADD CONSTRAINT handoff_events_handling_round_check
      CHECK (
        handling_round IS NULL
        OR handling_round BETWEEN 1 AND 1000
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_events_opened_round_required_check'
  ) THEN
    ALTER TABLE public.handoff_events
      ADD CONSTRAINT handoff_events_opened_round_required_check
      CHECK (
        event_type IS DISTINCT FROM 'opened'
        OR handling_round BETWEEN 1 AND 1000
      );
  END IF;
END
$m10c_event_round$;

CREATE UNIQUE INDEX IF NOT EXISTS handoff_events_opened_round_key
  ON public.handoff_events (transfer_id, handling_round)
  WHERE event_type = 'opened' AND transfer_id IS NOT NULL;

${legacyResultVersion}

DO $m10c_result_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_returned_with_reply_check'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_returned_with_reply_check
      CHECK (
        result_action IS DISTINCT FROM 'returned_with_reply'
        OR (
          result_note IS NOT NULL
          AND result_version_number IS NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_returned_with_file_check'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_returned_with_file_check
      CHECK (
        result_action IS DISTINCT FROM 'returned_with_file'
        OR result_version_number IS NOT NULL
      );
  END IF;
END
$m10c_result_checks$;

${canDelete}

${functions}

${grants}

COMMIT;
`;

writeFileSync(path.join(root, "supabase/manual-patch-m10c.sql"), patch);
console.log("composed supabase/manual-setup.sql and supabase/manual-patch-m10c.sql");
