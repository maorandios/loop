import { FormEvent, useState } from "react";
import { he } from "../../copy/he";
import { joinCodeHasChars, normalizeJoinCodeInput } from "./joinCode";

type WorkspaceSetupScreenProps = {
  creating?: boolean;
  joining?: boolean;
  error?: string | null;
  onCreateWorkspace: () => void | Promise<void>;
  onJoinWorkspace: (joinCode: string) => void | Promise<void>;
};

export function WorkspaceSetupScreen({
  creating = false,
  joining = false,
  error = null,
  onCreateWorkspace,
  onJoinWorkspace,
}: WorkspaceSetupScreenProps) {
  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = creating || joining;
  const shownError = localError ?? error;

  function onJoinSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeJoinCodeInput(joinCode);
    if (!joinCodeHasChars(normalized)) {
      setLocalError(he.joinCodeRequired);
      return;
    }
    setLocalError(null);
    void onJoinWorkspace(normalized);
  }

  return (
    <main className="fr-center">
      <div className="fr-center-inner">
        <div>
          <p className="fr-brand-name">{he.brand}</p>
          <h1 className="fr-sheet-title">{he.workspaceHowToStart}</h1>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void onCreateWorkspace()}
          className="fr-btn fr-btn-primary"
        >
          {creating ? he.creatingWorkspace : he.createWorkspace}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => setShowJoin(true)}
          className="fr-btn fr-btn-secondary"
        >
          {he.joinWorkspace}
        </button>

        {showJoin ? (
          <form onSubmit={onJoinSubmit} className="flex flex-col gap-3">
            <label className="fr-field-wrap">
              <span className="fr-label">{he.joinCodeLabel}</span>
              <input
                dir="ltr"
                value={joinCode}
                onChange={(event) => {
                  setJoinCode(event.currentTarget.value);
                  if (localError) {
                    setLocalError(null);
                  }
                }}
                className="fr-field"
                style={{ unicodeBidi: "isolate" }}
                autoComplete="off"
                disabled={busy}
                autoFocus
              />
            </label>
            <button type="submit" disabled={busy} className="fr-btn fr-btn-primary">
              {joining ? he.joiningWorkspace : he.joinWorkspace}
            </button>
          </form>
        ) : null}

        {shownError ? (
          <p role="alert" className="fr-field-error">
            {shownError}
          </p>
        ) : null}
      </div>
    </main>
  );
}
