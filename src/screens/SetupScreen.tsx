import { FormEvent, useState } from "react";
import { he } from "../copy/he";

type SetupScreenProps = {
  saving?: boolean;
  error?: string | null;
  onSubmitName: (name: string) => void | Promise<void>;
};

export function SetupScreen({
  saving = false,
  error = null,
  onSubmitName,
}: SetupScreenProps) {
  const [name, setName] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const shownError = localError ?? error;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setLocalError(he.deviceNameRequired);
      return;
    }
    setLocalError(null);
    void onSubmitName(trimmed);
  }

  return (
    <main className="fr-center">
      <form onSubmit={onSubmit} className="fr-center-inner">
        <div>
          <p className="fr-brand-name">{he.brand}</p>
          <h1 className="fr-sheet-title">{he.setupTitle}</h1>
          <p className="fr-hint">{he.setupQuestion}</p>
        </div>

        <label className="fr-field-wrap">
          <span className="fr-label">{he.deviceNameLabel}</span>
          <input
            dir="auto"
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (localError) {
                setLocalError(null);
              }
            }}
            className="fr-field fr-plaintext"
            autoFocus
            autoComplete="off"
            disabled={saving}
          />
        </label>

        {shownError ? (
          <p role="alert" className="fr-field-error">
            {shownError}
          </p>
        ) : null}

        <button type="submit" disabled={saving} className="fr-btn fr-btn-primary">
          {saving ? he.loading : he.continue}
        </button>

        <p className="fr-hint">{he.setupHint}</p>
      </form>
    </main>
  );
}
