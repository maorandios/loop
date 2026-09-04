import { he } from "../copy/he";

export function CloudNotConfiguredScreen() {
  return (
    <main className="flex min-h-dvh flex-col justify-center bg-zinc-50 px-6 py-8 text-zinc-900">
      <div className="mx-auto flex max-w-sm flex-col gap-3">
        <p className="text-sm font-medium text-zinc-500">{he.brand}</p>
        <h1 className="text-2xl font-semibold leading-snug">
          {he.cloudNotConfiguredTitle}
        </h1>
        <p className="text-base text-zinc-600">{he.cloudNotConfiguredBody}</p>
      </div>
    </main>
  );
}

export function CloudConnectingScreen() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-50 px-6 text-zinc-600">
      {he.cloudConnecting}
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
    <main className="flex min-h-dvh flex-col justify-center bg-zinc-50 px-6 py-8 text-zinc-900">
      <div className="mx-auto flex max-w-sm flex-col gap-3">
        <p className="text-sm font-medium text-zinc-500">{he.brand}</p>
        <h1 className="text-2xl font-semibold leading-snug">{title}</h1>
        {hint ? <p className="text-sm text-zinc-600">{hint}</p> : null}
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-lg bg-sky-700 px-4 py-2.5 text-base font-medium text-white hover:bg-sky-800"
        >
          {he.tryAgain}
        </button>
      </div>
    </main>
  );
}
