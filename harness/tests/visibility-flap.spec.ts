/**
 * A flapping consent panel must not strand the session.
 *
 * The panel pauses sharing when it is covered, clipped or scrolled away, and resumes when it
 * comes back — `docs/03-trust-model.md` §2a, and the reason nothing streams while the stop
 * control is unreachable. Pausing is a **capability narrowing**: `surfaces` goes empty and
 * comes back.
 *
 * What this file exists for is the resume. `state.current` inside the consent surface is the
 * ENGINE's echo — it is only ever assigned from `capability.changed` — so a panel that flaps
 * faster than the socket round trip re-narrows while the newest thing the frame has seen is
 * the echo of the *previous* narrow. Saving that as the thing to restore means every later
 * restore restores nothing:
 *
 *   - the customer's page never streams again, with the panel visible and the customer having
 *     done nothing;
 *   - the agent console sits on "waiting for the customer's page" for the rest of the session,
 *     because the snapshot it is waiting for is gated on a surface that never comes back;
 *   - and the audit chain fills with `[] -> []` at several rows a second.
 *
 * All three were seen in production together. The chain flood is what made it diagnosable
 * afterwards, which is worth keeping in mind: the symptom the agent reports ("stuck on a
 * loading screen") is three layers away from the cause.
 */

import { expect, test } from "@playwright/test";
import { goLive } from "./support.js";

/** Drive the geometry signal exactly as the SDK's `ConsentHost` does. */
async function geometry(page: import("@playwright/test").Page, ok: boolean): Promise<void> {
  await page.evaluate((v) => {
    const f = document.querySelector("iframe[data-sky-consent]") as HTMLIFrameElement;
    f.contentWindow!.postMessage(
      { type: "sky.geometry", ok: v, reason: v ? null : "covered" },
      "*"
    );
  }, ok);
}

async function watchCapability(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __caps: number[]; Sky: { on: (e: string, f: (d: never) => void) => void } };
    w.__caps = [];
    w.Sky.on("capability", ((d: { current: { surfaces: unknown[] } }) =>
      w.__caps.push(d.current.surfaces?.length ?? -1)) as never);
  });
}

async function readCapability(page: import("@playwright/test").Page) {
  return page.evaluate(() => ({
    caps: (window as unknown as { __caps: number[] }).__caps,
    state: (window as unknown as { Sky: { state: string } }).Sky.state
  }));
}

test("a panel that comes back brings the surface back with it", async ({ page }) => {
  // The ordinary case, asserted first so a regression cannot hide behind the harder one.
  await goLive(page);
  await page.waitForTimeout(300);
  await watchCapability(page);

  await geometry(page, false);
  await page.waitForTimeout(250);
  await geometry(page, true);
  await page.waitForTimeout(600);

  const out = await readCapability(page);
  expect(out.caps.at(-1), "the surface did not come back").toBe(1);
  expect(out.state).toBe("live");
});

test("a flap faster than the engine's echo still resumes", async ({ page }) => {
  await goLive(page);
  await page.waitForTimeout(300);
  await watchCapability(page);

  await page.evaluate(async () => {
    const f = document.querySelector("iframe[data-sky-consent]") as HTMLIFrameElement;
    const post = (ok: boolean) =>
      f.contentWindow!.postMessage({ type: "sky.geometry", ok, reason: ok ? null : "covered" }, "*");

    // Narrow, and let the echo land so the frame's own `state.current` becomes `[]`.
    post(false);
    await new Promise((r) => setTimeout(r, 250));
    // Then restore and re-narrow in the SAME tick, so the re-narrow reads `state.current`
    // before the restore's echo returns. Over a real network this is any flap faster than the
    // round trip; locally it takes a synchronous pair to force the same ordering.
    post(true);
    post(false);
    await new Promise((r) => setTimeout(r, 250));
    // And the panel ends visible, and stays visible.
    post(true);
  });
  await page.waitForTimeout(1500);

  const out = await readCapability(page);
  expect(out.caps.at(-1), "the panel is visible but the session has no surface").toBe(1);
  expect(out.state, "the SDK is not streaming though the panel is visible").toBe("live");
});

test("a flapping panel does not flood the session with no-op changes", async ({ page }) => {
  // The chain is append-only and merchant-readable. A `capability.set` that changes nothing is
  // still a row, and `capability.set` comes from the customer's page — the least trusted place
  // in the system. Production filled with `[] -> []` several times a second.
  await goLive(page);
  await page.waitForTimeout(300);
  await watchCapability(page);

  for (let i = 0; i < 6; i++) {
    await geometry(page, false);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(600);

  const out = await readCapability(page);
  const noops = out.caps.filter((n) => n === 0).length;
  expect(noops, `six identical narrow signals produced ${noops} capability changes`).toBeLessThanOrEqual(1);
});
