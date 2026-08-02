/**
 * What every spec in here needs, in one place.
 *
 * Five spec files had independently re-derived the same four things: the probe's path, the
 * "load the page and wait for the SDK" preamble, the consent frame's selector, and the
 * click-through-consent sequence. The probe path appeared twice verbatim, the `window.Sky`
 * wait eight times, and the start-then-allow-then-wait-for-`#live` dance seven times.
 *
 * None of that is interesting per spec, and every copy is a place the bootstrap can fall out
 * of step with the SDK it is bootstrapping.
 */

import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrivacyTier } from "../../sdk/src/config.js";

/** The test-only probe, built into `.probe/` by `build-probe.mjs` during global setup. */
export const PROBE = join(fileURLToPath(new URL("..", import.meta.url)), ".probe/probe.js");

/** The consent surface's frame. Ours, and the only iframe these fixtures create. */
export const CONSENT = "iframe[data-sky-consent]";

export function panel(page: Page) {
  return page.frameLocator(CONSENT);
}

/**
 * A corpus page with the probe attached and the SDK's internals reachable.
 *
 * Configuration goes through `applyOptions` — the same door an integrator uses — rather than by
 * assigning to the resolved config. Writing `config.privacy` directly skips `readTier` and
 * `compileSelectors`, so the strict-tier and selector tests would have been running against
 * values that never passed the validation those tiers depend on.
 */
export async function loadProbe(
  page: Page,
  corpus: string,
  options?: { privacy?: PrivacyTier; unmask?: string[]; mask?: string[]; block?: string[] }
): Promise<void> {
  await page.goto(`/${corpus}`);
  await page.addScriptTag({ path: PROBE });
  await page.waitForFunction(() => Boolean(window.__sky));
  if (options) await page.evaluate((o) => window.__sky.applyOptions(o), options);
}

/** A page with the shipped SDK bundle on it, waited for. */
export async function loadSdk(page: Page, corpus: string): Promise<void> {
  await page.goto(`/${corpus}`);
  await page.waitForFunction(() => typeof (window as { Sky?: unknown }).Sky === "object");
}

/** Open the consent panel the way the fixture's own launcher does. */
export async function ask(page: Page, corpus = "90-merchant.html"): Promise<void> {
  await loadSdk(page, corpus);
  if (corpus === "90-merchant.html") await page.click("#help");
  else await page.evaluate(() => (window as unknown as { __start: () => void }).__start());
  await expect(panel(page).locator("#ask")).toBeVisible();
}

/** Ask, allow, and wait until the session is live. */
export async function goLive(page: Page, corpus = "90-merchant.html"): Promise<void> {
  await ask(page, corpus);
  await panel(page).locator("#allow").click();
  await expect(panel(page).locator("#live")).toBeVisible();
}
