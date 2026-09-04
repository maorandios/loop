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
    <main className="flex min-h-dvh flex-col justify-center bg-zinc-50 px-6 py-8 text-zinc-900">
      <form
        onSubmit={onSubmit}
        className="mx-auto flex w-full max-w-sm flex-col gap-5"
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-500">{he.brand}</p>
          <h1 className="text-2xl font-semibold leading-snug">{he.setupTitle}</h1>
          <p className="text-base text-zinc-600">{he.setupQuestion}</p>
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">{he.deviceNameLabel}</span>
          <input
            dir="auto"
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (localError) {
                setLocalError(null);
              }
            }}
            placeholder={he.deviceNamePlaceholder}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-start text-base outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-200"
            autoFocus
            autoComplete="off"
            disabled={saving}
          />
        </label>

        {shownError ? (
          <p role="alert" className="text-sm text-red-700">
            {shownError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-sky-700 px-4 py-2.5 text-base font-medium text-white hover:bg-sky-800 disabled:opacity-60"
        >
          {saving ? he.loading : he.continue}
        </button>

        <p className="text-sm leading-relaxed text-zinc-500">{he.setupHint}</p>
      </form>
    </main>
  );
}
