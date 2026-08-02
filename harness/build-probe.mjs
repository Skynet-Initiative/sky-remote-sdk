/** Builds the test-only probe. Run by Playwright's global setup, never by the release
 *  build — nothing here may end up in a shipped artefact. */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  await build({
    entryPoints: [join(HERE, "src/probe.ts")],
    outfile: join(HERE, ".probe/probe.js"),
    bundle: true,
    format: "iife",
    target: ["chrome100"],
    logLevel: "warning"
  });
}
