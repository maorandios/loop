import { he } from "../../copy/he";
import type { InboxExtraFilter } from "../handoff/inboxList";
import type { WorkspaceMember } from "./types";

type FilterPopoverProps = {
  filter: InboxExtraFilter;
  members: WorkspaceMember[];
  onChange: (next: InboxExtraFilter) => void;
  onApply: () => void;
  onClear: () => void;
};

export function FilterPopover({
  filter,
  members,
  onChange,
  onApply,
  onClear,
}: FilterPopoverProps) {
  return (
    <div className="fr-filter-pop" role="dialog" aria-modal="true" aria-label={he.filterRequests}>
      <label className="fr-field-wrap">
        <span className="fr-label">{he.filterUser}</span>
        <select
          className="fr-select"
          value={filter.memberId ?? ""}
          onChange={(event) => {
            onChange({ ...filter, memberId: event.target.value || null });
          }}
        >
          <option value="">{he.filterAny}</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="fr-field-wrap">
        <span className="fr-label">{he.filterKind}</span>
        <select
          className="fr-select"
          value={filter.action}
          onChange={(event) => {
            onChange({
              ...filter,
              action: event.target.value as InboxExtraFilter["action"],
            });
          }}
        >
          <option value="any">{he.filterAny}</option>
          <option value="approval">{he.actionForApproval}</option>
          <option value="review">{he.actionForReview}</option>
          <option value="update">{he.actionForUpdate}</option>
          <option value="file_request">{he.actionFileRequest}</option>
        </select>
      </label>
      <label className="fr-field-wrap">
        <span className="fr-label">{he.filterDue}</span>
        <select
          className="fr-select"
          value={filter.due}
          onChange={(event) => {
            onChange({ ...filter, due: event.target.value as InboxExtraFilter["due"] });
          }}
        >
          <option value="any">{he.filterAny}</option>
          <option value="has">{he.filterHasDue}</option>
          <option value="none">{he.filterNoDue}</option>
        </select>
      </label>
      <div className="fr-choice">
        <label>
          <input
            type="radio"
            name="inbox-kind"
            checked={filter.kind === "any"}
            onChange={() => {
              onChange({ ...filter, kind: "any" });
            }}
          />
          <span>{he.filterAny}</span>
        </label>
        <label>
          <input
            type="radio"
            name="inbox-kind"
            checked={filter.kind === "with_file"}
            onChange={() => {
              onChange({ ...filter, kind: "with_file" });
            }}
          />
          <span>{he.filterWithFile}</span>
        </label>
        <label>
          <input
            type="radio"
            name="inbox-kind"
            checked={filter.kind === "file_request"}
            onChange={() => {
              onChange({ ...filter, kind: "file_request" });
            }}
          />
          <span>{he.filterFileRequest}</span>
        </label>
      </div>
      <div className="fr-sheet-actions">
        <button type="button" className="fr-btn fr-btn-secondary" onClick={onClear}>
          {he.clearFilter}
        </button>
        <button type="button" className="fr-btn fr-btn-primary" onClick={onApply}>
          {he.applyFilter}
        </button>
      </div>
    </div>
  );
}
