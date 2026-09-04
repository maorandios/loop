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
    <main className="flex min-h-dvh flex-col justify-center bg-zinc-50 px-6 py-8 text-zinc-900">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-500">{he.brand}</p>
          <h1 className="text-2xl font-semibold leading-snug">
            {he.workspaceHowToStart}
          </h1>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void onCreateWorkspace()}
          className="rounded-lg bg-sky-700 px-4 py-2.5 text-base font-medium text-white hover:bg-sky-800 disabled:opacity-60"
        >
          {creating ? he.creatingWorkspace : he.createWorkspace}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => setShowJoin(true)}
          className="rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-base font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-60"
        >
          {he.joinWorkspace}
        </button>

        {showJoin ? (
          <form onSubmit={onJoinSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium">{he.joinCodeLabel}</span>
              <input
                dir="ltr"
                value={joinCode}
                onChange={(event) => {
                  setJoinCode(event.currentTarget.value);
                  if (localError) {
                    setLocalError(null);
                  }
                }}
                placeholder={he.joinCodePlaceholder}
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-start text-base outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-200"
                style={{ unicodeBidi: "isolate" }}
                autoComplete="off"
                disabled={busy}
                autoFocus
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-sky-700 px-4 py-2.5 text-base font-medium text-white hover:bg-sky-800 disabled:opacity-60"
            >
              {joining ? he.joiningWorkspace : he.joinWorkspace}
            </button>
          </form>
        ) : null}

        {shownError ? (
          <p role="alert" className="text-sm text-red-700">
            {shownError}
          </p>
        ) : null}
      </div>
    </main>
  );
}
