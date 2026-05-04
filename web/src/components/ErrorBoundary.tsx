import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center bg-slate-900 p-6">
          <div className="max-w-md rounded border border-red-700 bg-red-950 p-4 font-mono text-sm text-red-200">
            <div className="mb-2 font-semibold">Algo se rompió.</div>
            <pre className="whitespace-pre-wrap break-words text-xs text-red-300">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="mt-3 rounded bg-red-700 px-3 py-1 text-xs hover:bg-red-600"
            >
              Reintentar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
