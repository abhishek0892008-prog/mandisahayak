/**
 * Bundles the Vercel serverless entrypoint into a single plain-JS file at
 * api/index.js before Vercel's own function builder ever looks at the api/
 * directory.
 *
 * Why this exists: api/index.ts imported server/src/*.ts with relative,
 * extension-ful specifiers (`../server/src/core/config.ts`), and left those
 * as separate files for Vercel's Node builder to trace and copy alongside
 * the compiled entrypoint. In production that tracing silently dropped
 * files — the deployed function crashed with
 * `ERR_MODULE_NOT_FOUND: /var/task/server/src/core/config.ts` even though
 * the same file existed one directory up. Bundling everything into one file
 * ourselves removes that tracing step entirely: there is nothing left for
 * the builder to lose. `packages: 'external'` keeps node_modules (express,
 * pg, zod, ...) out of the bundle; npm install still supplies those.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";

rmSync("api", { recursive: true, force: true });
mkdirSync("api", { recursive: true });

await build({
  entryPoints: ["scripts/vercel-entry.ts"],
  outfile: "api/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

console.log("Bundled scripts/vercel-entry.ts -> api/index.js");
