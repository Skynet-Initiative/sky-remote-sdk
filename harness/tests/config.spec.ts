/**
 * Configuration, and the properties an integrator's own code depends on.
 *
 * `applyOptions` is not called once. It runs on every `configure()`, and again from
 * `requestAssistance()` and from `present()` — so an integrator who configures per route, or a
 * React effect that re-runs, or a launcher that passes options at call time, reaches it many
 * times in one page life. That makes **idempotence a correctness property**, not a nicety: the
 * same options in have to produce the same resolved config out, or the SDK's behaviour depends
 * on how many times it was configured.
 *
 * These run in a browser because `compileSelectors` validates against `document.querySelector`
 * — the validation is the point, and a fake would be testing the fake.
 */

import { expect, test } from "@playwright/test";
import { loadProbe } from "./support.js";

test("configuring twice with the same options changes nothing the second time", async ({
  page
}) => {
  await loadProbe(page, "07-sensitive-fields.html");
  const lengths = await page.evaluate(() => {
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      window.__sky.applyOptions({ mask: [".x"] });
      out.push(window.__sky.config.mask.length);
    }
    return out;
  });
  // It used to be [2, 3, 4, 5]: the resolved config already held the floor plus the previous
  // call's additions, and each call concatenated onto that. Every duplicate is a full
  // `el.matches()` on every element of every ancestry walk — on the path that also runs on
  // every keystroke.
  expect(lengths, "the mask list grew on re-configuration").toEqual([2, 2, 2, 2]);
});

test("the built-in opt-out markers survive a merchant's own mask list", async ({ page }) => {
  await loadProbe(page, "07-sensitive-fields.html");
  const kept = await page.evaluate(() => {
    window.__sky.applyOptions({ mask: [".mine"] });
    const mask = window.__sky.config.mask;
    return {
      hasFloor: mask.some((s) => s.includes("[data-sky-private]")),
      hasMine: mask.includes(".mine")
    };
  });
  // The floor is a floor: a merchant adding to it must never be able to remove it, or an
  // element already annotated for another vendor would silently start streaming.
  expect(kept.hasFloor, "the opt-out floor was replaced").toBe(true);
  expect(kept.hasMine).toBe(true);
});

test("a malformed selector refuses rather than masking less than asked", async ({ page }) => {
  await loadProbe(page, "07-sensitive-fields.html");
  const threw = await page.evaluate(() => {
    try {
      window.__sky.applyOptions({ mask: ["<<<not css>>>"] });
      return null;
    } catch (e) {
      return String((e as Error).message);
    }
  });
  // D-19 fail-closed: skipping a bad selector means masking less than the page asked for and
  // saying nothing about it.
  expect(threw).toContain("not valid CSS");
});

test("a rejected selector list leaves the previous configuration intact", async ({ page }) => {
  await loadProbe(page, "07-sensitive-fields.html");
  const after = await page.evaluate(() => {
    window.__sky.applyOptions({ mask: [".good"] });
    const before = [...window.__sky.config.mask];
    try {
      window.__sky.applyOptions({ mask: ["<<<bad>>>"] });
    } catch {
      /* expected */
    }
    return { before, now: [...window.__sky.config.mask] };
  });
  // `compileSelectors` validates the whole list before assigning, so a throw cannot leave the
  // config holding half of a rejected call.
  expect(after.now).toEqual(after.before);
});
