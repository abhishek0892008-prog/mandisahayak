import { Component } from "react";

/**
 * Application-level error boundary.
 *
 * A render error in one screen should not leave the farmer looking at a blank
 * page with no way forward. This is deliberately not translated: it must work
 * even when the failure is in i18n itself, so it carries both languages
 * inline.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled UI error:", error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-2xl">
            ⚠️
          </div>

          <h1 className="mt-4 text-lg font-bold text-slate-900">Something went wrong</h1>
          <p className="mt-1 text-sm text-slate-500">कुछ गलत हो गया</p>

          <button
            type="button"
            onClick={() => window.location.assign("/")}
            className="mt-6 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-800"
          >
            Reload · पुनः लोड करें
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
