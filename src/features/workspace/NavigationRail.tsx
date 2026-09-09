import type { Ref } from "react";
import { he } from "../../copy/he";
import { FluentIcon, type IconName } from "../../icons/fluent";
import { PRIMARY_VIEWS, type PrimaryView } from "../handoff/mailbox";

const RAIL_ICONS: Record<PrimaryView, IconName> = {
  action: "mailInboxArrowDown",
  info: "mailInboxArrowUp",
  completed: "mailInboxCheckmark",
};

const RAIL_ICON_SIZE = 22;

function railLabel(tab: PrimaryView): string {
  if (tab === "action") {
    return he.primaryAction;
  }
  if (tab === "info") {
    return he.primaryInfo;
  }
  return he.primaryCompleted;
}

type NavigationRailProps = {
  primaryView: PrimaryView;
  settingsOpen: boolean;
  unread: Record<PrimaryView, boolean>;
  settingsRef: Ref<HTMLButtonElement>;
  onSelectView: (view: PrimaryView) => void;
  onOpenSettings: () => void;
};

export function NavigationRail({
  primaryView,
  settingsOpen,
  unread,
  settingsRef,
  onSelectView,
  onOpenSettings,
}: NavigationRailProps) {
  return (
    <aside className="fr-rail">
      <div className="fr-rail-brand">
        <span className="fr-brand-mark fr-brand-logo" aria-hidden="true">
          <img src="/logo.svg" alt="" width={31} height={31} />
        </span>
        <h1 className="fr-sr-only">{he.appName}</h1>
      </div>
      <div role="tablist" aria-label={he.requestsTitle} className="fr-rail-tabs">
        {PRIMARY_VIEWS.map((tab) => {
          const selected = !settingsOpen && primaryView === tab;
          const hasUnread = unread[tab];
          const label = railLabel(tab);
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-current={selected ? "page" : undefined}
              aria-label={hasUnread ? `${label}, ${he.unreadRequests}` : label}
              data-tooltip={label}
              className="fr-rail-btn"
              onClick={() => {
                onSelectView(tab);
              }}
            >
              <FluentIcon name={RAIL_ICONS[tab]} size={RAIL_ICON_SIZE} />
              {hasUnread ? <span className="fr-rail-dot" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <div className="fr-rail-foot">
        <span className="fr-rail-sep" aria-hidden="true" />
        <button
          type="button"
          className="fr-rail-btn"
          aria-label={he.settings}
          aria-current={settingsOpen ? "page" : undefined}
          data-tooltip={he.settings}
          ref={settingsRef}
          onClick={onOpenSettings}
        >
          <FluentIcon name="settings" size={RAIL_ICON_SIZE} />
        </button>
      </div>
    </aside>
  );
}
