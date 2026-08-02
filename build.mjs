#!/usr/bin/env node
/**
 * The build for the three browser artefacts.
 *
 * ## This repository is public, and that is the security argument rather than a concession
 *
 * Everything here runs in someone else's page with full DOM access. The trust model rests part
 * of the SDK's safety on the shipped bytes being traceable to public source *by someone who does
 * not trust us* — so the source is public, unobfuscated, and `sky.debug.js` is built unminified
 * for exactly that reader. Obfuscating a bundle that is already delivered to every visitor's
 * browser would protect nothing and would cost the one property that claim depends on.
 *
 * What protects the work instead is the licence, and `checkLicence` below is why that is a
 * property of the build rather than a line in a README. See `LICENSE` at the repository root.
 *
 * ## What "zero runtime dependencies" means now that there is a build step
 *
 * The integration contract, embed rule 2, forbids dependencies **in the shipped bundle**, not a
 * build step. The rule is honoured here as two properties, each checked rather than asserted:
 *
 *  1. **Nothing third-party reaches the browser.** `esbuild` and `typescript` are build tools;
 *     the output contains only source from this repository. `checkNoDependencies` fails the
 *     build if any package here ever declares a runtime `dependencies` entry.
 *  2. **The privacy claim holds in the bytes.** `checkNoStorage` greps the built artefacts for
 *     browser storage APIs, because the claim that earns a merchant a script tag instead of a
 *     legal review is a property of what ships, not of what the source intended.
 *
 * And now a third, for the same reason as the other two:
 *
 *  3. **The terms travel with the bytes.** `checkLicence` fails the build if the manifest, the
 *     `LICENSE` file and the banner in every artefact do not agree. A merchant who has only
 *     `sky.js` — pulled from a CDN, or found in a bundle — can read what they are allowed to do
 *     with it without having to find this repository first.
 *
 * ## Versioning is npm's job, and this file does not do it
 *
 * There is no version guard here, no immutable artefact directory, and no committed `dist/`.
 * A published version is immutable because the registry says so; the bytes behind it are
 * attested by npm provenance, which binds a tarball to the commit and workflow that built it
 * and is verifiable by anyone with `npm audit signatures`. Reimplementing that locally cost
 * more than it bought.
 *
 * The single source of truth for the version is `sdk/package.json`, which is what `npm version`
 * edits. `__SKY_VERSION__` is injected from it so the running bundle can report what it is.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild, context as esbuildContext } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(await readFile(join(HERE, "sdk/package.json"), "utf8")).version;

/**
 * The licence, as three facts the build compares against each other.
 *
 * They are stated here rather than read from `LICENSE`, because the point of the check is that
 * the file cannot be swapped without the build noticing — parsing the file for the values to
 * then compare against the file would notice nothing. Changing the terms means changing this
 * object *and* the file, deliberately, in one commit.
 *
 * `grant` is not the licence and does not try to be. It is the one-line summary that has to
 * survive into bytes that may reach a reader with no repository attached; `LICENSE` is
 * authoritative and the banner says so.
 */
const LICENCE = {
  spdx: "BUSL-1.1",
  changeDate: "2030-08-02",
  changeLicense: "Apache License, Version 2.0",
  repo: "https://github.com/Skynet-Initiative/sky-remote-sdk"
};

/** Prepended to every JavaScript artefact, minified or not. */
const BANNER = `/*! @skynet-initiative/sky-remote ${VERSION} | (c) 2026 Skynet Initiative
 * Business Source License 1.1. Production use on web properties you operate is granted free of
 * charge; use in a competing co-browse or remote-assistance product is not. Converts to the
 * Apache License 2.0 on ${LICENCE.changeDate}. Full terms: ${LICENCE.repo}/blob/main/LICENSE
 * This file is built from public source. Verify it: ${LICENCE.repo}/blob/main/VERIFYING.md */`;

const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith("--only="))?.slice(7) ?? null;
const watch = args.has("--watch");
const publishCheck = args.has("--publish-check");
/** `--release` adds the checks that are policy rather than defect. See `checkPublishable`. */
const releaseGate = args.has("--release");

/** Same settings for every artefact, so two bundles never differ by a flag. */
const COMMON = {
  bundle: true,
  target: ["chrome100", "firefox100", "safari15.4", "edge100"],
  charset: "utf8",
  legalComments: "inline",
  logLevel: "warning",
  banner: { js: BANNER },
  define: { __SKY_VERSION__: JSON.stringify(VERSION) }
};

/**
 * Every JavaScript artefact this run produced, for the invariant checks at the bottom.
 *
 * Collected here rather than read back from disk, so the checks run on exactly what was emitted.
 */
const emitted = [];
const written = [];

/** Build one artefact. Returns nothing: every caller writes through `emit`. */
async function bundle(entry, outfile, format, extra = {}) {
  const options = {
    ...COMMON,
    entryPoints: [join(HERE, entry)],
    outfile: join(HERE, outfile),
    format,
    write: false,
    ...extra
  };
  if (watch) {
    // Watch writes directly: the invariant checks are a release concern, and running them on
    // every keystroke would fail the loop on half-typed code.
    const ctx = await esbuildContext({ ...options, write: true });
    await ctx.watch();
    return;
  }
  const result = await esbuild(options);
  await emit(outfile, result.outputFiles[0].text);
}

async function emit(outfile, contents) {
  const path = join(HERE, outfile);
  if (outfile.endsWith(".js") || outfile.endsWith(".mjs") || outfile.endsWith(".cjs")) {
    emitted.push([relative(HERE, path), contents]);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  written.push(relative(HERE, path));
}

// ---------------------------------------------------------------------------
// The SDK
// ---------------------------------------------------------------------------

async function buildSdk() {
  // The script-tag build. IIFE, so it can be dropped into any page, and the global is assigned
  // by `global.ts` rather than by a bundler banner.
  await bundle("sdk/src/global.ts", "sdk/dist/sky.js", "iife", { minify: true });
  // The bundler builds. Named exports, no global, tree-shakeable.
  await bundle("sdk/src/index.ts", "sdk/dist/sky.mjs", "esm", { minify: false });
  await bundle("sdk/src/index.ts", "sdk/dist/sky.cjs", "cjs", { minify: false });
  // Readable, for anyone auditing what runs on their customers' pages.
  await bundle("sdk/src/global.ts", "sdk/dist/sky.debug.js", "iife", { minify: false });
}

// ---------------------------------------------------------------------------
// The mirror rebuilder
// ---------------------------------------------------------------------------

async function buildMirror() {
  if (!watch) await rm(join(HERE, "mirror/dist"), { recursive: true, force: true });
  await bundle("mirror/src/index.ts", "mirror/dist/index.js", "esm", { minify: false });
}

// ---------------------------------------------------------------------------
// The consent surface
// ---------------------------------------------------------------------------

async function buildConsent() {
  if (!watch) await rm(join(HERE, "consent/dist"), { recursive: true, force: true });
  await bundle("consent/src/consent.ts", "consent/dist/consent.js", "esm", { minify: true });

  // The stylesheet is inlined rather than linked: `default-src 'none'` means this origin
  // fetches nothing, and a consent dialog that renders unstyled while a stylesheet loads
  // is one the customer reads in the wrong order.
  const html = await readFile(join(HERE, "consent/src/index.html"), "utf8");
  const css = await readFile(join(HERE, "consent/src/styles.css"), "utf8");
  if (!html.includes("/* STYLES */")) {
    throw new Error("consent/src/index.html has no `/* STYLES */` placeholder to inline into");
  }
  await emit("consent/dist/index.html", html.replace("/* STYLES */", "\n" + css.trim() + "\n  "));
}

// ---------------------------------------------------------------------------
// The licence, into the package that ships it
// ---------------------------------------------------------------------------

/**
 * `LICENSE` at the repository root is the only copy anyone edits; this puts it where npm will
 * pack it from.
 *
 * npm only includes files inside the package directory, and the package directory is `sdk/`. The
 * alternative — a second committed copy — is a file that can be edited on one side and not the
 * other, which is the failure this whole section exists to prevent. So it is generated, ignored
 * by git, and `checkPublishable` refuses to publish without it.
 */
async function buildLicence() {
  await emit("sdk/LICENSE", await readFile(join(HERE, "LICENSE"), "utf8"));
}

/**
 * The terms, checked in the three places they have to agree.
 *
 * A licence is only protection if it reaches the person deciding what to do with the code, and
 * there are three of them: the integrator reading npm's metadata, the lawyer reading the file in
 * the tarball, and the engineer who has nothing but a minified bundle pulled off a CDN. Each is
 * served by a different artefact, and any one of them being wrong is silent.
 *
 * The failure this is really aimed at is quieter than a wrong licence. `sdk/package.json` says
 * Apache-2.0 for one commit, someone installs it, and the grant they relied on was never the one
 * we meant to give — a mistake that cannot be taken back, because they already have the tarball.
 * npm's own checks have no opinion here: it publishes any licence string, including one that
 * contradicts the file next to it.
 */
async function checkLicence(artefacts) {
  const problems = [];

  const manifest = JSON.parse(await readFile(join(HERE, "sdk/package.json"), "utf8"));
  if (manifest.license !== LICENCE.spdx) {
    problems.push(
      `sdk/package.json says \`license: ${JSON.stringify(manifest.license)}\`, this build says ` +
        `${LICENCE.spdx}. Whichever is wrong, an integrator's dependency audit reads the manifest.`
    );
  }

  // The parameter block is the part of BUSL that is ours. Stock BUSL with `Additional Use Grant:
  // None` forbids production use outright, which would make every merchant an infringer — so the
  // grant is checked for presence, not just the file for existence.
  const licence = await readFile(join(HERE, "LICENSE"), "utf8");
  const required = [
    ["Change Date", `Change Date:          ${LICENCE.changeDate}`],
    ["Change License", `Change License:       ${LICENCE.changeLicense}`],
    ["the Licensed Work's name", "Licensed Work:        @skynet-initiative/sky-remote"],
    ["the production-use grant", "You may use, and make production use of, the Licensed"],
    ["the competing-product exclusion", "whose purpose is co-browsing, screen sharing, session"],
    ["the security-review carve-out", "publishing the results of a security"]
  ];
  for (const [what, needle] of required) {
    if (!licence.includes(needle)) {
      problems.push(
        `LICENSE is missing ${what}. Expected to find: ${JSON.stringify(needle)}.\n` +
          "    A Business Source License with no Additional Use Grant forbids production use, so " +
          "losing that paragraph\n    silently turns every merchant running this into an infringer."
      );
    }
  }

  // The reader who has only the bytes. Checked on the raw text: the banner is a comment, and
  // `checkNoStorage` strips comments before it runs, so these two cannot be folded together.
  for (const [name, text] of artefacts) {
    if (!text.startsWith(BANNER)) {
      problems.push(
        `${name} does not carry the licence banner. A bundle found without this repository ` +
          "attached has no terms on it at all."
      );
    }
  }

  if (problems.length) {
    throw new Error(
      "the licence is not consistent across the artefacts that carry it:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nThe terms are a product decision. If they are changing, change `LICENCE` in this file " +
        "and\n`LICENSE` at the root together, in one commit, and say so in the message.\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Types, for the published package
// ---------------------------------------------------------------------------

async function buildTypes() {
  // `tsc` is run by `npm run types`; this copies its declaration output into the package so a
  // consumer installing the tarball gets types that resolve. The layout is preserved because
  // the emitted declarations import each other by relative path.
  const src = join(HERE, ".types");
  if (!existsSync(src)) {
    throw new Error("packages/.types is missing — run `npm run types` before building");
  }
  for (const [from, to] of [
    ["protocol", "sdk/dist/types/protocol"],
    ["sdk", "sdk/dist/types/sdk"],
    ["protocol", "mirror/dist/types/protocol"],
    ["mirror", "mirror/dist/types/mirror"]
  ]) {
    await copyTree(join(src, from), join(HERE, to));
  }
}

async function copyTree(from, to) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    await emit(relative(HERE, target), await readFile(source, "utf8"));
  }
}

// ---------------------------------------------------------------------------
// The invariants that are product claims, not build hygiene
// ---------------------------------------------------------------------------

async function checkNoDependencies() {
  for (const pkg of ["sdk", "mirror", "consent"]) {
    const path = join(HERE, pkg, "package.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const deps = Object.keys(manifest.dependencies ?? {});
    if (deps.length) {
      throw new Error(
        `${pkg}/package.json declares runtime dependencies (${deps.join(", ")}). ` +
          "Embed rule 2 is zero, not few — a single transitive dependency in a bundle with full " +
          "DOM access on thousands of merchant sites is the Polyfill risk reintroduced."
      );
    }
  }
}

/**
 * The ePrivacy claim, checked against the bytes rather than asserted in a header.
 *
 * `sdk/src/index.ts` rule 2 promises there is no `localStorage`, `sessionStorage`,
 * `document.cookie` or `indexedDB` **anywhere in this package** — and that is not a style
 * preference. It is the reason a merchant can add the script tag without declaring us in their
 * consent-management platform, which is the difference between integration being a script tag
 * and integration being a legal review. It is the first thing a privacy reviewer greps for.
 *
 * Checked on the built artefacts, not on source: what matters is what reaches the browser.
 *
 * **Comments are stripped first, and every one of them.** The rule's own text names all four
 * APIs and is preserved into the bundle by `legalComments: "inline"`, so a check reading the raw
 * file would find the claim and report it as a violation.
 */
function checkNoStorage(artefacts) {
  const banned = /\b(localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie)\b/;
  for (const [name, text] of artefacts) {
    // Crude, and correct for the question being asked: a string literal containing `/*` would
    // over-strip and could only ever cause this check to miss something, which costs a false
    // negative on a deliberate `sessionStorage` — not a broken build on an honest one.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const hit = banned.exec(code);
    if (hit) {
      throw new Error(
        `${name} uses \`${hit[1]}\`.\n\n` +
          "The SDK promises no browser storage of any kind: that is what lets a merchant add the\n" +
          "script tag without declaring us in their consent-management platform. If this is\n" +
          "deliberate, the claim in sdk/src/index.ts and sdk/README.md has to be withdrawn first —\n" +
          "and that is a product decision, not a build failure to route around."
      );
    }
  }
}

/**
 * What has to be true before this package goes to a registry, checked rather than remembered.
 *
 * Publishing is the one irreversible action here: npm's unpublish window is narrow and a
 * name+version is burned for good afterwards. These are the ways a tarball is wrong that
 * `npm publish` itself would not catch:
 *
 *  1. **`private`**, which npm catches — but after packing, and without naming which manifest.
 *  2. **A tarball with no `LICENSE` in it.** The manifest's `license` field is a label; the file
 *     is the grant. `checkLicence` has already confirmed the two agree, so what is left to check
 *     is that the file is actually packed — and it is generated by `buildLicence`, so "the build
 *     did not run" and "the terms are missing" are the same failure.
 *  3. **An `exports` target that `files` does not ship.** The classic packaging bug: the tarball
 *     installs clean and throws `ERR_MODULE_NOT_FOUND` on first import, because locally the
 *     package resolves through the source tree where every path exists.
 *
 * The licence gate used to be `--release` only, on the reasoning that the terms were an open
 * decision and a `main` permanently red over an unanswered question is a `main` nobody reads.
 * They are no longer open, so it runs on every commit like the other two.
 */
async function checkPublishable() {
  const path = join(HERE, "sdk/package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const problems = [];

  if (manifest.private) problems.push("`private: true` — remove it to publish");
  if (!existsSync(join(HERE, "sdk/LICENSE"))) {
    problems.push("`sdk/LICENSE` is missing — run `npm run build`, which generates it from `LICENSE`");
  }

  const files = (manifest.files ?? []).map((f) => f.replace(/^\.\//, "").replace(/\/$/, ""));
  // npm's `files` semantics: an entry is either the exact path or a directory containing it.
  const shipped = (target) => {
    const clean = target.replace(/^\.\//, "");
    return files.some((f) => clean === f || clean.startsWith(f + "/"));
  };

  // Every entry point, from the `exports` map and the legacy fields older bundlers still read.
  const targets = new Set();
  const collect = (node) => {
    if (typeof node === "string") targets.add(node);
    else if (node && typeof node === "object") Object.values(node).forEach(collect);
  };
  collect(manifest.exports);
  for (const field of ["main", "module", "types", "unpkg", "browser"]) {
    if (typeof manifest[field] === "string") targets.add(manifest[field]);
  }

  for (const target of [...targets].sort()) {
    if (target.endsWith("package.json")) continue; // always in the tarball
    if (!existsSync(join(HERE, "sdk", target))) {
      problems.push(`\`${target}\` is an entry point with no file — run \`npm run build\``);
    } else if (!shipped(target)) {
      problems.push(`\`${target}\` is an entry point that \`files\` does not ship`);
    }
  }

  // npm packs a root `LICENSE` whether or not `files` lists it, but only for the *package* root.
  // Listing it is what makes the intent reviewable in the manifest.
  if (!shipped("LICENSE")) {
    problems.push("`files` does not list `LICENSE` — the tarball would ship terms nobody can read");
  }

  // **Everything this build puts in the package has to leave in the tarball.**
  //
  // The `exports` check above only sees entry points, and that is the narrow half of the problem.
  // `sky.debug.js` is not an entry point — nothing imports it — so it passed every check while
  // being built, ignored by `files`, and absent from the tarball. It was found by publishing
  // 0.1.0 and then running `verify.mjs` against it, which is later than anyone would like:
  // `deploy/build-sdk-origin.mjs` copies that file out of the installed package, so the SDK
  // origin's image build would have failed on the first deploy after the first release, and the
  // unminified build the trust model points auditors at would not have existed.
  //
  // So the rule is inverted: the build declares what it emitted, and anything not shipped has to
  // be named here as a deliberate exclusion rather than silently dropped.
  const NOT_SHIPPED = new Set([]);
  for (const path of written) {
    if (!path.startsWith("sdk/")) continue; // mirror and consent are not published
    const inPackage = path.slice("sdk/".length);
    if (NOT_SHIPPED.has(inPackage) || shipped(inPackage)) continue;
    problems.push(
      `\`${inPackage}\` is built into the package but \`files\` does not ship it. Add it to ` +
        "`files`, or to `NOT_SHIPPED` in build.mjs if leaving it out is deliberate"
    );
  }

  if (!problems.length) {
    const tier = releaseGate ? "publishable" : "packaging is coherent";
    console.log(
      `publish-check: ${manifest.name}@${manifest.version} — ${tier} (${manifest.license})`
    );
    return;
  }
  throw new Error(
    `sdk/package.json is not ready to publish:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nPublishing is irreversible — a name and version cannot be reused once burned.\n"
  );
}

// ---------------------------------------------------------------------------

await checkNoDependencies();
if (!only || only === "sdk") await buildSdk();
if (!only || only === "mirror") await buildMirror();
if (!only || only === "consent") await buildConsent();
if (!only && !watch) await buildTypes();
if ((!only || only === "sdk") && !watch) await buildLicence();

if (watch) {
  console.log(`[sky] watching ${only ?? "sdk, mirror, consent"} — ${VERSION}`);
} else {
  checkNoStorage(emitted);
  await checkLicence(emitted);
  if (publishCheck) await checkPublishable();
  console.log(`built ${VERSION} — ${written.length} files (${LICENCE.spdx})`);
}
