/**
 * Single source of truth for the package version. Reads package.json at
 * startup; everything else imports `VERSION` from here so a `package.json`
 * bump propagates without manually syncing http.ts and server.ts.
 *
 * Runtime: dist/version.js sits next to dist/cli.js after tsc, and
 * package.json is copied to /app/ (one level up) in the Dockerfile.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// dist/version.js → ../package.json (during local `tsx` runs this is src/version.ts → ../package.json — same relative path).
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  version: string;
};
export const VERSION: string = pkg.version;
