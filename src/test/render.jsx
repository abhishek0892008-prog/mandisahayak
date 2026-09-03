import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AuthProvider from "../auth/AuthProvider";

/**
 * Renders a screen inside the providers it actually depends on.
 *
 * The AuthProvider is real, not stubbed: it resolves the session from the
 * mocked `GET /me` exactly as it does in the browser. That means these tests
 * exercise the genuine sign-in path rather than a convenient fake of it.
 */
export function renderScreen(ui, { route = "/", path, state } = {}) {
  const entries = [state ? { pathname: route, state } : route];

  return render(
    <MemoryRouter initialEntries={entries}>
      <AuthProvider>
        {path ? (
          <Routes>
            <Route path={path} element={ui} />
          </Routes>
        ) : (
          ui
        )}
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Renders without auth, for screens that must work signed out. */
export function renderBare(ui, { route = "/" } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  );
}
