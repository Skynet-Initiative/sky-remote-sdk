/**
 * The public API surface, pinned.
 *
 * `sdk/API.md` documents eleven members and four framework integrations written against them.
 * Documentation that drifts from the object it describes is worse than none — an integrator
 * follows it, the call is not there, and the failure looks like our bug rather than our
 * paragraph. This is the test that makes renaming or dropping a documented member a red build.
 *
 * Run in a browser rather than in Node because the SDK is a browser API: it hosts a frame and
 * compiles selectors against a real `document`.
 */

import { expect, test } from "@playwright/test";
import { loadSdk } from "./support.js";

/**
 * Exactly what `API.md` documents, and what type each is.
 *
 * One table rather than a name list plus a method list: those overlapped, were checked by two
 * different mechanisms, and adding a documented member meant editing both. The types are here
 * because the docs promise them too — `Sky.protocol` is a number in the reference, and a string
 * would be a silent break for anyone comparing it.
 */
const SURFACE: Record<string, string> = {
  active: "boolean",
  cancelRequest: "function",
  configure: "function",
  off: "function",
  on: "function",
  present: "function",
  protocol: "number",
  requestAssistance: "function",
  state: "string",
  stop: "function",
  version: "string"
};

test("the global exposes exactly the documented surface", async ({ page }) => {
  await loadSdk(page, "90-merchant.html");

  const surface = await page.evaluate(() => {
    const S = (window as unknown as { Sky: Record<string, unknown> }).Sky;
    const kinds: Record<string, string> = {};
    for (const key of Object.keys(S).sort()) kinds[key] = typeof S[key];
    return kinds;
  });

  // Both directions, in one assertion. Missing a member breaks an integrator following the docs;
  // gaining an undocumented one means we shipped surface area nobody wrote down, which is how the
  // "there is no documentation" complaint starts.
  expect(surface).toEqual(SURFACE);
});

test("state and version read the way the docs say they do", async ({ page }) => {
  await loadSdk(page, "90-merchant.html");

  const out = await page.evaluate(() => {
    const S = (window as unknown as { Sky: Record<string, unknown> }).Sky;
    return { state: S.state, active: S.active, version: S.version, protocol: S.protocol };
  });

  // "Nothing is happening. Nothing has touched the device." — the documented initial state.
  expect(out.state).toBe("idle");
  expect(out.active).toBe(false);
  // The exact version belongs to `sdk/package.json`, which the build injects. Here it only has
  // to be a version at all — and to be injected rather than the literal `__SKY_VERSION__`,
  // which is what a broken define would leave behind.
  expect(String(out.version)).toMatch(/^\d+\.\d+\.\d+$/);
});

/**
 * `on` and `off` chain, because every framework example in API.md relies on it.
 */
test("on and off return the instance so they chain", async ({ page }) => {
  await loadSdk(page, "90-merchant.html");

  const chains = await page.evaluate(() => {
    const S = (window as unknown as {
      Sky: { on: (e: string, f: () => void) => unknown; off: (e: string, f: () => void) => unknown };
    }).Sky;
    const noop = () => undefined;
    return { on: S.on("state", noop) === S, off: S.off("state", noop) === S };
  });

  expect(chains.on).toBe(true);
  expect(chains.off).toBe(true);
});

/**
 * The queue pattern in API.md, exercised for real.
 *
 * A page that pushes calls before the bundle arrives has to end up in the same place as one
 * that waited — that is the whole reason the snippet may go in `<head>`.
 */
test("calls queued before the bundle loads are replayed", async ({ page }) => {
  await page.goto("/93-queued-calls.html");
  await page.waitForFunction(() => typeof (window as { Sky?: unknown }).Sky === "object");

  const applied = await page.evaluate(
    () => (window as unknown as { __queueResult: { configured: boolean; listener: boolean } }).__queueResult
  );
  expect(applied.configured, "a queued configure() was not applied").toBe(true);
  expect(applied.listener, "a queued on() was not registered").toBe(true);
});
