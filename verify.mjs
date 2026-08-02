#!/usr/bin/env node
/**
 * Rebuild a published release from this source and compare it to the tarball on npm.
 *
 * ## What this is for, and what it is not for
 *
 * The rule this exists to serve is narrow: **anything we claim about the shipped bytes must be
 * checkable against the shipped bytes.** The claims are zero runtime dependencies, no browser
 * storage, and the licence — `build.mjs` checks those against what it emits. This closes the last
 * gap, between what the build emits and what the registry actually serves.
 *
 * It is deliberately not framed as a safety property any more. An earlier version of the trust
 * model listed "traceable to public source" alongside "we do not write that code" as if both
 * *prevented* an SDK from reading credentials. Only the second one does. This script makes a
 * dishonest release **discoverable**, by someone who runs it; it does not make one impossible,
 * and almost nobody runs it. Sold as anything more than that, it is theatre.
 *
 * Two mechanisms, kept apart because they fail differently:
 *
 *  - **`npm audit signatures`** proves the registry is serving what our workflow uploaded, and
 *    that no third party published as us. That last part is the only genuine security property
 *    here, and its threat model is not us.
 *  - **This script** proves the source and the artefact agree. It does not prove the source is
 *    honest — read it, or do not; it is public either way.
 *
 * ## Usage
 *
 *   node verify.mjs             # verify the version in sdk/package.json
 *   node verify.mjs 0.1.0       # verify a specific published version
 *
 * Exit status is 0 only if every shipped artefact matched byte for byte.
 *
 * ## Why byte-for-byte is a reasonable bar here
 *
 * Because the build is deterministic and has no inputs it does not pin. `esbuild` is fixed by
 * `package-lock.json`, the only injected value is the version string, and nothing consults the
 * clock, the environment or the network. `npm run check` in CI rebuilds and compares on every
 * commit so that this stays true rather than being true by luck on the day it was written.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = "@skynet-initiative/sky-remote";

/** Every file the tarball ships that this repository is supposed to be able to reproduce. */
const ARTEFACTS = ["dist/sky.js", "dist/sky.mjs", "dist/sky.cjs"];

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const localVersion = JSON.parse(readFileSync(join(HERE, "sdk/package.json"), "utf8")).version;
const version = process.argv[2] ?? localVersion;

console.log(`verifying ${PKG}@${version} against this working tree\n`);

// A mismatch here is the difference between "the release is wrong" and "you are on the wrong
// commit", and confusing the two wastes a lot of somebody's afternoon.
if (version !== localVersion) {
  console.log(
    `note: this tree is ${localVersion}, verifying ${version}.\n` +
      `      Check out the release first:  git checkout sdk-v${version}\n`
  );
}

const work = mkdtempSync(join(tmpdir(), "sky-verify-"));
let failures = 0;

try {
  // ---------------------------------------------------------------------------
  // 1. The registry's copy, and whether the registry can vouch for it
  // ---------------------------------------------------------------------------

  console.log("1. downloading the published tarball");
  run("npm", ["pack", `${PKG}@${version}`, "--pack-destination", work], { cwd: work });
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error(`npm pack produced no tarball for ${PKG}@${version}`);
  run("tar", ["-xzf", join(work, tarball), "-C", work]);
  const published = join(work, "package");
  console.log(`   ${tarball}`);

  console.log("\n2. checking npm provenance");
  // `npm audit signatures` reads the *project's* dependency tree, so it needs a directory that
  // looks like a project: a `package.json` naming the dependency and a lockfile beside it.
  // Installing with `--prefix` into a bare directory populates `node_modules` and writes neither,
  // and the command then reports "found no installed dependencies to audit" — which reads like a
  // verification failure and is really an empty question.
  const installed = join(work, "audit");
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ name: "sky-verify", version: "0.0.0", private: true }, null, 2)
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `${PKG}@${version}`], {
    cwd: installed
  });
  try {
    const out = run("npm", ["audit", "signatures"], { cwd: installed });
    console.log("   " + out.trim().split("\n").join("\n   "));
  } catch (error) {
    console.log("   FAILED — the registry could not vouch for these bytes");
    console.log("   " + String(error.stdout ?? error.message).trim().split("\n").slice(0, 4).join("\n   "));
    failures++;
  }

  // ---------------------------------------------------------------------------
  // 3. What this source produces
  // ---------------------------------------------------------------------------

  console.log("\n3. building from this working tree");
  if (!existsSync(join(HERE, "node_modules"))) {
    console.log("   installing pinned dependencies (npm ci)");
    run("npm", ["ci"], { cwd: HERE });
  }
  run("npm", ["run", "build"], { cwd: HERE });

  // ---------------------------------------------------------------------------
  // 4. The comparison the whole script exists for
  // ---------------------------------------------------------------------------

  console.log("\n4. comparing artefacts\n");
  for (const rel of ARTEFACTS) {
    const theirs = join(published, rel);
    const ours = join(HERE, "sdk", rel);
    if (!existsSync(theirs)) {
      console.log(`   MISSING   ${rel} — not in the published tarball`);
      failures++;
      continue;
    }
    if (!existsSync(ours)) {
      console.log(`   MISSING   ${rel} — the build did not produce it`);
      failures++;
      continue;
    }
    const a = readFileSync(theirs);
    const b = readFileSync(ours);
    if (a.equals(b)) {
      console.log(`   match     ${rel.padEnd(20)} sha256:${sha(a).slice(0, 16)}  ${a.length} bytes`);
    } else {
      console.log(`   MISMATCH  ${rel}`);
      console.log(`     published: sha256:${sha(a)}  ${a.length} bytes`);
      console.log(`     rebuilt:   sha256:${sha(b)}  ${b.length} bytes`);
      failures++;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log();
if (failures) {
  console.error(
    `${failures} check(s) failed.\n\n` +
      "If you are on the tagged commit and dependencies came from the committed lockfile, this\n" +
      "means the published bytes are not the ones this source produces. That is worth reporting:\n" +
      "https://github.com/Skynet-Initiative/sky-remote-sdk/issues\n"
  );
  process.exit(1);
}
console.log(`${PKG}@${version} is exactly what this source builds.\n`);
