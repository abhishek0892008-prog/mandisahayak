import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import "../i18n";

// jsdom has no fetch worth using here. Every test installs its own handler
// through src/test/server.js; this guarantees an unstubbed test fails loudly
// instead of hitting the network.
beforeEach(() => {
  globalThis.fetch = vi.fn(() => {
    throw new Error("fetch called with no mock installed — use mockApi() from test/server.js");
  });

  // The CSRF cookie the client echoes on writes.
  document.cookie = "fq_csrf=test-csrf-token";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
