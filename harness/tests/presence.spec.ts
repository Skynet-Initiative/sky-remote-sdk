/**
 * Presence cursors, asserted at the wire.
 *
 * **The assertions here are about the bytes, not about the pixels**, and that is deliberate.
 * `sky-remote`'s fidelity suite compares rendered output, so anything that leaks in a *frame*
 * rather than in a *render* is invisible to it — the mirror looks identical whether or not a
 * coordinate escaped from inside a masked field. What D-26
 * promises is about what leaves the browser, so it is checked by capturing what the SDK would
 * send.
 *
 * Four claims:
 *
 *  1. **A pointer over ordinary content is reported.** The feature works at all, which is worth
 *     asserting first so that a suppression bug cannot pass as a passing suite.
 *  2. **A pointer inside a masked region is not.** Not clamped, not rounded, not reported at
 *     the region's edge — dropped. A coordinate inside a region we promised not to transmit is
 *     a partial read of it: caret position implies value length and dwell implies a credential
 *     is being entered right now.
 *  3. **Presence stops when the stream does**, in both directions, and the overlay is *removed*
 *     rather than hidden (D-27). A cursor still moving on a
 *     paused page is refuse-list item 2 with the indicator telling the truth about the mirror
 *     and not about us.
 *  4. **The agent's cursor is never mirrored back.** Our own overlay is an ordinary same-origin
 *     `<div>`, so without the serializer skip it would be serialized as part of the customer's
 *     page and rendered a second time in the console — an echo chasing the real cursor, one
 *     frame behind, on every move.
 */

import { expect, test, type Page } from "@playwright/test";
import type { MirrorNode } from "../../protocol/src/index.js";
import { loadProbe } from "./support.js";

/** The SDK throttles, so a single move produces a frame only after the interval elapses. */
const SETTLE_MS = 120;

/** Move the real pointer over an element and wait for the throttle to fire. */
async function pointAt(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(SETTLE_MS);
}

/** What the SDK has queued for the wire since the last clear. */
async function sent(page: Page) {
  return page.evaluate(() => window.__sky.presence.sent());
}

async function startPresence(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__sky.presence.start();
    window.__sky.presence.clear();
  });
}

test.describe("the customer's cursor", () => {
  test("an ordinary field reports a position", async ({ page }) => {
    // The positive case first. Without it a suppression bug — or a presence loop that never
    // starts — would sail through every assertion below, because "nothing was sent" is what
    // they are all checking for.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);

    await pointAt(page, '[data-probe="promo"]');

    const frames = await sent(page);
    expect(frames.length).toBeGreaterThan(0);
    const last = frames.at(-1)!;
    expect(last.x).not.toBeNull();
    expect(last.y).not.toBeNull();
    expect(last.x).toBeGreaterThanOrEqual(0);
    expect(last.x).toBeLessThanOrEqual(1);
  });

  test("a masked field reports nothing at all", async ({ page }) => {
    // D-26. The card number is masked by the classifier with no merchant configuration, and a
    // coordinate inside it must not leave the page — in any form. This is the assertion the
    // fidelity suite structurally cannot make.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);

    await pointAt(page, '[data-probe="cc-by-autocomplete"]');

    const frames = await sent(page);
    // Whatever was sent, none of it may carry a position. `x: null` is the honest report —
    // "the customer is somewhere we said we would not report" — and it is what the agent sees
    // as the cursor disappearing.
    for (const frame of frames) {
      expect(frame.x, "a coordinate escaped from inside a masked field").toBeNull();
      expect(frame.y).toBeNull();
    }
  });

  test("moving out of a masked field starts reporting again", async ({ page }) => {
    // The suppression is positional and not sticky. A customer who fills in their card number
    // and moves on must not vanish for the rest of the session — which is what a latched flag
    // would produce, and it would look like the feature simply not working.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);

    await pointAt(page, '[data-probe="cc-by-autocomplete"]');
    await page.evaluate(() => window.__sky.presence.clear());
    await pointAt(page, '[data-probe="heading"]');

    const frames = await sent(page);
    expect(frames.some((f) => f.x !== null)).toBe(true);
  });

  test("stopping removes the overlay rather than hiding it", async ({ page }) => {
    // D-27. Nothing of ours may outlive the stream on a customer's page, and a hidden element
    // is one CSS rule away from being visible again.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);
    await page.evaluate(() =>
      window.__sky.presence.show({ x: 0.5, y: 0.5 }, "Cyclo SAS", "Amélie")
    );
    expect(await page.locator("[data-sky-presence]").count()).toBeGreaterThan(0);

    await page.evaluate(() => window.__sky.presence.stop());

    expect(
      await page.locator("[data-sky-presence]").count(),
      "the overlay outlived the stream"
    ).toBe(0);
  });

  test("a stopped presence sends nothing", async ({ page }) => {
    // The other half of D-27: not merely that the drawing stops, but that the *channel* does.
    // This is the case that matters — a customer who pauses sharing and keeps browsing while
    // their cursor still streams is being watched after pressing the control that says they
    // are not.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);
    await page.evaluate(() => {
      window.__sky.presence.stop();
      window.__sky.presence.clear();
    });

    await pointAt(page, '[data-probe="heading"]');

    expect(await sent(page), "a paused session kept reporting the pointer").toEqual([]);
  });
});

test.describe("the agent's cursor", () => {
  test("is drawn with the merchant's name leading", async ({ page }) => {
    // Contract §7's surviving insight after D-25 reversed its rule: a stranger's name means
    // nothing to a customer on its own and means something beside a name they recognise.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);

    await page.evaluate(() =>
      window.__sky.presence.show({ x: 0.25, y: 0.25 }, "Cyclo SAS", "Amélie")
    );

    const overlay = page.locator("[data-sky-presence]").first();
    await expect(overlay).toHaveCSS("opacity", "1");
    await expect(page.locator("[data-sky-presence] span")).toHaveText("Cyclo SAS · Amélie");
  });

  test("renders unlabelled rather than rendering a token", async ({ page }) => {
    // A name that was never pushed over the admin plane yields `null`, and the renderer must
    // show absence rather than falling back to an identifier. An `act_7f21…` on a customer's
    // own page is noise that looks like a defect.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);

    await page.evaluate(() => window.__sky.presence.show({ x: 0.25, y: 0.25 }, "Cyclo SAS", null));

    await expect(page.locator("[data-sky-presence] span")).toHaveText("Cyclo SAS");
  });

  test("hides when the agent is pointing at nothing", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);
    await page.evaluate(() => window.__sky.presence.show({ x: 0.5, y: 0.5 }, "Cyclo SAS", null));
    await expect(page.locator("[data-sky-presence]").first()).toHaveCSS("opacity", "1");

    await page.evaluate(() => window.__sky.presence.show({ x: null, y: null }, "Cyclo SAS", null));

    await expect(page.locator("[data-sky-presence]").first()).toHaveCSS("opacity", "0");
  });

  test("cannot intercept a click meant for the page underneath", async ({ page }) => {
    // The overlay sits above the customer's own content. If it could take a pointer event it
    // would be a hole punched in the page by the thing drawing the cursor — the clickjacking
    // risk the consent surface's geometry watch exists to prevent, arriving through our own
    // decoration.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);
    await page.evaluate(() => window.__sky.presence.show({ x: 0.5, y: 0.5 }, "Cyclo SAS", null));

    for (const el of await page.locator("[data-sky-presence]").all()) {
      await expect(el).toHaveCSS("pointer-events", "none");
    }
  });

  test("is never serialized back into the mirror", async ({ page }) => {
    // Without the serializer's skip the console would render the agent's own cursor a second
    // time, from the customer's page, one frame behind the real one.
    await loadProbe(page, "07-sensitive-fields.html");
    await startPresence(page);
    await page.evaluate(() =>
      window.__sky.presence.show({ x: 0.5, y: 0.5 }, "Cyclo SAS", "Amélie")
    );

    const leaked = await page.evaluate(() => {
      const found: string[] = [];
      const walk = (n: MirrorNode): void => {
        if (n.a?.["data-sky-presence"] !== undefined) found.push(String(n.id));
        for (const c of n.c ?? []) walk(c);
      };
      walk(window.__sky.snapshot().root);
      return found;
    });

    expect(leaked, "the presence overlay was mirrored to the agent").toEqual([]);
  });
});
