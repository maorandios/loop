import type { ReactNode } from "react";
import { he } from "../../copy/he";
import { FluentIcon } from "../../icons/fluent";

type WorkspaceToolbarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  filter: ReactNode;
  compose: ReactNode;
};

export function WorkspaceToolbar({
  searchQuery,
  onSearchChange,
  filter,
  compose,
}: WorkspaceToolbarProps) {
  return (
    <div className="fr-toolbar">
      <label className="fr-search">
        <FluentIcon name="search" size={16} />
        <span className="fr-sr-only">{he.searchRequests}</span>
        <input
          type="search"
          value={searchQuery}
          placeholder={he.searchRequests}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            onSearchChange(event.target.value);
          }}
        />
        {searchQuery.trim() ? (
          <button
            type="button"
            className="fr-search-clear"
            aria-label={he.clearSearch}
            onClick={() => {
              onSearchChange("");
            }}
          >
            <FluentIcon name="dismiss" size={14} />
          </button>
        ) : null}
      </label>
      {filter}
      {compose}
    </div>
  );
}
