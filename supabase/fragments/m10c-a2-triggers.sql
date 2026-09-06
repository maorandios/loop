DROP TRIGGER IF EXISTS handoffs_original_filename_trg ON public.handoffs;
CREATE CONSTRAINT TRIGGER handoffs_original_filename_trg
AFTER INSERT OR UPDATE OF original_filename, flow_version ON public.handoffs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.assert_handoff_original_filename();

DROP TRIGGER IF EXISTS handoff_transfers_original_filename_trg ON public.handoff_transfers;
CREATE CONSTRAINT TRIGGER handoff_transfers_original_filename_trg
AFTER INSERT OR UPDATE OF requested_action, parent_transfer_id, handoff_id ON public.handoff_transfers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.assert_handoff_original_filename();
