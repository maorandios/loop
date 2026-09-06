import { he } from "../copy/he";

export function CloudNotConfiguredScreen() {
  return (
    <main className="fr-center">
      <div className="fr-center-inner">
        <p className="fr-brand-name">{he.brand}</p>
        <h1 className="fr-sheet-title">{he.cloudNotConfiguredTitle}</h1>
        <p className="fr-hint">{he.cloudNotConfiguredBody}</p>
      </div>
    </main>
  );
}

export function CloudConnectingScreen() {
  return (
    <main className="fr-center">
      <div className="fr-center-inner">
        <div className="fr-skeleton" aria-hidden="true">
          <div className="fr-skel" style={{ width: "40%" }} />
          <div className="fr-skel" style={{ width: "70%" }} />
          <div className="fr-skel" style={{ width: "55%" }} />
        </div>
        <p className="fr-hint">{he.cloudConnecting}</p>
      </div>
    </main>
  );
}

type CloudProblemScreenProps = {
  title: string;
  hint?: string | null;
  onRetry: () => void;
};

export function CloudProblemScreen({
  title,
  hint = null,
  onRetry,
}: CloudProblemScreenProps) {
  return (
    <main className="fr-center">
      <div className="fr-center-inner">
        <p className="fr-brand-name">{he.brand}</p>
        <h1 className="fr-sheet-title">{title}</h1>
        {hint ? <p className="fr-hint">{hint}</p> : null}
        <button type="button" onClick={onRetry} className="fr-btn fr-btn-primary">
          {he.tryAgain}
        </button>
      </div>
    </main>
  );
}
