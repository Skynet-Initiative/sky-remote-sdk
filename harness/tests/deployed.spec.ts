/**
 * The consent surface that is actually deployed.
 *
 * What this can check and what it cannot, stated plainly. The **panel** is production's:
 * it loads from `consent.skynet-initiative.com`, into a frame the locally built SDK
 * created and sized. The **flow** is not — Chrome refuses an `https:` origin a socket to
 * `ws://localhost`, so the deployed panel cannot reach the mock engine, and pointing it at
 * the production engine would mint a real session against a real merchant.
 *
 * So this asserts the two things that shipped broken and would have shipped broken again:
 * the frame's geometry, and the surface's own content security policy.
 */
import { expect, test } from "@playwright/test";

const CONSENT = "iframe[data-sky-consent]";

test("the deployed panel is hosted at a usable size, not the 150px an iframe defaults to", async ({
  page
}) => {
  await page.goto("/92-merchant-prod-consent.html");
  await page.waitForFunction(() => typeof (window as { Sky?: unknown }).Sky === "object");
  await page.click("#help");
  await expect(page.locator(CONSENT)).toBeAttached();
  await page.waitForTimeout(1200);

  const viewport = page.viewportSize()!;
  const box = await page.locator(CONSENT).boundingBox();
  expect(box, "the consent frame has no box").not.toBeNull();

  // The defect that reached a customer: `height: auto` on a replaced element is 150px, so
  // the card was cropped and Allow sat below the fold. The ask state is the whole viewport.
  expect(box!.height, `the frame is only ${Math.round(box!.height)}px tall`).toBeGreaterThan(300);
  expect(Math.round(box!.height)).toBe(viewport.height);
  expect(Math.round(box!.width)).toBe(viewport.width);

  // And it is in the top layer, above anything the page could put over it.
  const onTop = await page.evaluate(() => {
    const host = document.querySelector("dialog[data-sky-consent]");
    if (!host) return false;
    const r = host.getBoundingClientRect();
    const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return stack[0] === host || host.contains(stack[0]!);
  });
  expect(onTop, "the deployed panel is not on top of the stack").toBe(true);
});

test("the deployed origin refuses script it did not serve", async ({ page }) => {
  // Cloudflare injects a bot-detection inline script into this document. It is refused by
  // the surface's own `script-src 'self'`, and this is the test that says so — a third
  // party executing on the origin that holds the signing key would defeat the whole design.
  await page.goto("https://consent.skynet-initiative.com/");
  await page.waitForTimeout(1200);
  const injectedRan = await page.evaluate(() => "__CF$cv$params" in window);
  expect(injectedRan, "an injected inline script executed on the consent origin").toBe(false);

  const csp = await page.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? ""
  );
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-inline'; script");
});
