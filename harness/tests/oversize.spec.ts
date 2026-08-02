/**
 * A page too large to mirror says so, rather than dying quietly.
 *
 * The engine closes a connection carrying a frame over 4 MiB, and since the limit is now
 * enforced at the transport there is not even an error frame to read: the socket simply goes
 * away. Without a check on this end, that reaches the customer as a session that ends by itself
 * on page load and reaches the integrator as "your SDK does not work on our product page".
 *
 * The serializer bounds its parts — 32 KB per inline image, 512 KB per stylesheet — and nothing
 * bounded the assembled whole, which is the gap this closes. It cannot make the page smaller, so
 * it reports through `degraded`, the channel that already means "the mirror is not going to be
 * what you expect, and here is why".
 */

import { expect, test } from "@playwright/test";
import { goLive } from "./support.js";

interface Recorded {
  name: string;
  detail: { what?: string };
}

/** Grow the document past the frame limit with text the serializer must carry verbatim. */
async function inflate(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.createElement("div");
    // 4 MiB of text, in chunks large enough that the node count stays sane — the limit under
    // test is bytes on the wire, not nodes.
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 80; i++) {
      const p = document.createElement("p");
      p.textContent = chunk;
      host.appendChild(p);
    }
    document.body.appendChild(host);
  });
}

test("an oversized snapshot is reported through `degraded`", async ({ page }) => {
  await goLive(page);
  await inflate(page);
  // Force a re-snapshot of the now-huge page the way a route change would.
  await page.evaluate(() => history.pushState({}, "", "?inflated"));
  await page.waitForTimeout(1200);

  const events = await page.evaluate(
    () => (window as unknown as { __events: Recorded[] }).__events
  );
  const oversize = events.filter(
    (e) => e.name === "degraded" && /frame limit/.test(e.detail?.what ?? "")
  );
  expect(oversize.length, "no degraded event named the frame limit").toBeGreaterThan(0);
  // The message has to carry the actual size: "too big" without a number is not actionable,
  // and the first question an integrator asks is how far over they are.
  expect(oversize[0]!.detail.what).toMatch(/\d+ KB/);
});

test("an ordinary page reports no frame-limit warning", async ({ page }) => {
  await goLive(page);
  await page.waitForTimeout(600);
  const events = await page.evaluate(
    () => (window as unknown as { __events: Recorded[] }).__events
  );
  // The negative case carries the weight: a size check that fires on a normal page would train
  // integrators to ignore the one channel that tells them the mirror is wrong.
  expect(events.filter((e) => e.name === "degraded" && /frame limit/.test(e.detail?.what ?? ""))).toEqual(
    []
  );
});
