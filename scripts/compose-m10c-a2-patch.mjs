import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const helpers = read("supabase/fragments/m10c-a2-helpers.sql").trimEnd();
const triggers = read("supabase/fragments/m10c-a2-triggers.sql").trimEnd();
const functions = read("supabase/fragments/m10c-a2-functions.sql").trimEnd();
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

const helperStart = "-- M10C-A2-HELPERS-START";
const helperEnd = "-- M10C-A2-HELPERS-END";
const triggerStart = "-- M10C-A2-TRIGGERS-START";
const triggerEnd = "-- M10C-A2-TRIGGERS-END";
const fnStart = "-- M10C-A2-FUNCTIONS-START";
const fnEnd = "-- M10C-A2-FUNCTIONS-END";
const grantStart = "-- M10C-A2-GRANTS-START";
const grantEnd = "-- M10C-A2-GRANTS-END";

const grants = `REVOKE ALL ON FUNCTION private.assert_safe_file_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.insert_handoff_version(uuid, integer, text, bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_reserved_upload_matches(uuid, uuid, uuid, uuid, bigint, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_handoff_original_filename() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_file_request_v2(uuid, text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_file_request_result(uuid, text, uuid, bigint, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_file_request_v2(uuid, text, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_file_request_result(uuid, text, uuid, bigint, text, uuid) TO authenticated;`;

function replaceMarker(source, start, end, body) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (startAt === -1 || endAt === -1 || endAt < startAt) {
    throw new Error(`missing markers ${start} / ${end}`);
  }
  return `${source.slice(0, startAt + start.length)}\n${body}\n${source.slice(endAt)}`;
}

function insertAfter(source, anchor, block) {
  const at = source.indexOf(anchor);
  if (at === -1) {
    throw new Error(`missing anchor ${anchor}`);
  }
  const end = at + anchor.length;
  return `${source.slice(0, end)}\n\n${block}${source.slice(end)}`;
}

let nextSetup = setup;
if (!setup.includes(helperStart)) {
  nextSetup = insertAfter(
    nextSetup,
    "EXECUTE FUNCTION private.handoff_transfers_active_status_ok();",
    `${helperStart}\n${helpers}\n${helperEnd}\n\n${triggerStart}\n${triggers}\n${triggerEnd}\n`,
  );
} else {
  nextSetup = replaceMarker(nextSetup, helperStart, helperEnd, helpers);
  if (!nextSetup.includes(triggerStart)) {
    nextSetup = insertAfter(nextSetup, helperEnd, `\n${triggerStart}\n${triggers}\n${triggerEnd}\n`);
  } else {
    nextSetup = replaceMarker(nextSetup, triggerStart, triggerEnd, triggers);
  }
}

if (!nextSetup.includes(fnStart)) {
  const fnAnchor = "-- M10C-FUNCTIONS-END";
  nextSetup = insertAfter(nextSetup, fnAnchor, `\n${fnStart}\n${functions}\n${fnEnd}\n`);
} else {
  nextSetup = replaceMarker(nextSetup, fnStart, fnEnd, functions);
}

if (!nextSetup.includes(grantStart)) {
  const grantAnchor = "-- M10C-GRANTS-END";
  nextSetup = insertAfter(nextSetup, grantAnchor, `\n${grantStart}\n${grants}\n${grantEnd}\n`);
} else {
  nextSetup = replaceMarker(nextSetup, grantStart, grantEnd, grants);
}

writeFileSync(path.join(root, "supabase/manual-setup.sql"), nextSetup);

const writers = [
  functionBody(nextSetup, "private.assert_result_matches_request("),
  functionBody(nextSetup, "public.mark_root_transfer_opened("),
  functionBody(nextSetup, "public.accept_root_transfer_result("),
  functionBody(nextSetup, "public.finalize_handoff_v1("),
  functionBody(nextSetup, "public.finalize_handoff_return_v2("),
  functionBody(nextSetup, "public.finalize_handoff_return("),
  functionBody(nextSetup, "public.finalize_handoff_v2_initial("),
  functionBody(nextSetup, "public.finalize_transfer_result("),
].join("\n\n");

const patch = `-- FileRelay Milestone 10C-A2 patch
-- Apply once in the Supabase SQL Editor after manual-patch-m10c.sql and manual-patch-m10c-fix1.sql.
-- New projects should run supabase/manual-setup.sql instead.
-- Idempotent and safe to re-run. Do not use the Supabase CLI.
-- Adds file_request and per-version file_name. Does not rewrite storage paths.

BEGIN;

DO $m10c_a2_requested_action$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handoff_transfers'
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%requested_action%'
      AND pg_catalog.pg_get_constraintdef(c.oid) NOT ILIKE '%file_request%'
  LOOP
    EXECUTE format('ALTER TABLE public.handoff_transfers DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_requested_action_check'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_requested_action_check
      CHECK (requested_action IN ('approval', 'review', 'update', 'file_request'));
  END IF;
END
$m10c_a2_requested_action$;

ALTER TABLE public.handoffs
  ALTER COLUMN original_filename DROP NOT NULL;

DO $m10c_a2_original_filename_check$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handoffs'
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%original_filename%'
      AND pg_catalog.pg_get_constraintdef(c.oid) NOT ILIKE '%IS NULL%'
  LOOP
    EXECUTE format('ALTER TABLE public.handoffs DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoffs_original_filename_null_or_safe_check'
  ) THEN
    ALTER TABLE public.handoffs
      ADD CONSTRAINT handoffs_original_filename_null_or_safe_check
      CHECK (
        original_filename IS NULL
        OR (
          pg_catalog.char_length(pg_catalog.btrim(original_filename)) BETWEEN 1 AND 255
          AND original_filename !~ '[[:cntrl:]]'
          AND original_filename !~ '[. ]$'
        )
      );
  END IF;
END
$m10c_a2_original_filename_check$;

ALTER TABLE public.handoff_versions
  ADD COLUMN IF NOT EXISTS file_name text;

UPDATE public.handoff_versions v
SET file_name = h.original_filename
FROM public.handoffs h
WHERE v.handoff_id = h.id
  AND v.file_name IS NULL;

DO $m10c_a2_version_file_name_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.handoff_versions
    WHERE file_name IS NULL
       OR pg_catalog.btrim(file_name) = ''
  ) THEN
    RAISE EXCEPTION 'm10c_a2_version_file_name_unmigratable' USING ERRCODE = 'P0001';
  END IF;
END
$m10c_a2_version_file_name_guard$;

${helpers}

${triggers}

${writers}

${functions}

DO $m10c_a2_file_name_not_null$
BEGIN
  ALTER TABLE public.handoff_versions
    ALTER COLUMN file_name SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_versions_file_name_safe_check'
  ) THEN
    ALTER TABLE public.handoff_versions
      ADD CONSTRAINT handoff_versions_file_name_safe_check
      CHECK (
        pg_catalog.char_length(pg_catalog.btrim(file_name)) BETWEEN 1 AND 255
        AND file_name !~ '[[:cntrl:]]'
        AND file_name !~ '[. ]$'
      );
  END IF;
END
$m10c_a2_file_name_not_null$;

${grants}

COMMIT;
`;

writeFileSync(path.join(root, "supabase/manual-patch-m10c-a2.sql"), patch);
console.log("composed supabase/manual-setup.sql and supabase/manual-patch-m10c-a2.sql");
