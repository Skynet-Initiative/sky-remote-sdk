#!/usr/bin/env node
/**
 * Build twice from a clean output directory and fail if the two differ.
 *
 * `VERIFYING.md` tells an integrator they can rebuild a release and compare it byte for byte
 * against the tarball on npm. That instruction is only honest while the build is deterministic,
 * and determinism is the kind of property that breaks quietly — a timestamp in a banner, a
 * `Date.now()` in a generated comment, a `Set` iteration that happens to be stable on one
 * machine. Any of those turns `verify.mjs` into a script that reports tampering on an honest
 * release, which is worse than not shipping it at all: it teaches people to ignore the check.
 *
 * So the property is tested rather than assumed, on every commit, in the same run as everything
 * else that is a product claim rather than build hygiene.
 *
 * This does not prove reproducibility across machines — a different `esbuild` build for a
 * different platform could in principle differ. `package-lock.json` pins the version, and CI
 * runs on the same platform an integrator most likely will.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUTS = ["sdk/dist", "mirror/dist", "consent/dist"];

function hashTree() {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(HERE, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  for (const dir of OUTPUTS) walk(join(HERE, dir));
  return out;
}

function build() {
  for (const dir of OUTPUTS) rmSync(join(HERE, dir), { recursive: true, force: true });
  execFileSync("node", [join(HERE, "build.mjs")], { cwd: HERE, stdio: ["ignore", "ignore", "inherit"] });
  return hashTree();
}

const first = build();
const second = build();

const differences = [];
for (const [file, hash] of first) {
  const other = second.get(file);
  if (other === undefined) differences.push(`${file}: produced by the first build only`);
  else if (other !== hash) differences.push(`${file}: ${hash.slice(0, 16)} then ${other.slice(0, 16)}`);
}
for (const file of second.keys()) {
  if (!first.has(file)) differences.push(`${file}: produced by the second build only`);
}

if (differences.length) {
  console.error(
    "the build is not reproducible — two runs of the same source produced different bytes:\n" +
      differences.map((d) => `  - ${d}`).join("\n") +
      "\n\nVERIFYING.md tells integrators to rebuild a release and compare it byte for byte against\n" +
      "npm. While this is failing, that check reports tampering on honest releases.\n"
  );
  process.exit(1);
}

console.log(`reproducible: ${first.size} artefacts identical across two clean builds`);
