import { useState, type FormEvent, type ReactNode } from "react";
import { useUiStore } from "../store";

interface Props {
  children: ReactNode;
}

export function ApiKeyGate({ children }: Props) {
  const apiKey = useUiStore((s) => s.apiKey);
  const setApiKey = useUiStore((s) => s.setApiKey);
  const [draft, setDraft] = useState("");

  if (apiKey) return <>{children}</>;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (trimmed) setApiKey(trimmed);
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-900 p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md space-y-4 rounded-lg border border-slate-700 bg-slate-800 p-6 shadow-xl"
      >
        <header>
          <h1 className="text-xl font-semibold text-slate-100">
            DENUE Analyzer
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Pega tu API key para empezar. Se guarda en{" "}
            <code className="text-cyan-400">localStorage</code> de este
            navegador.
          </p>
        </header>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="X-Api-Key"
          className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="w-full rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-slate-50 hover:bg-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-600"
        >
          Entrar
        </button>
      </form>
    </div>
  );
}
