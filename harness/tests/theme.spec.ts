/**
 * The consent panel wearing a merchant's brand, in a real browser.
 *
 * The unit tests in `packages/tests/theme.test.ts` prove the validator refuses what it
 * should. These prove the two things a validator cannot: that an accepted theme actually
 * reaches the pixels, and that a refused one leaves a panel that still works.
 *
 * The theme arrives from the mock engine, not from the page, because that is where it comes
 * from in production — it is workspace configuration like the legal name and the logo, and
 * the embedding page is the party a compromise comes from.
 */

import { expect, test, type Page } from "@playwright/test";

const CONSENT = "iframe[data-sky-consent]";

async function withTheme(page: Page, theme: unknown): Promise<void> {
  await page.request.post("http://localhost:4180/theme", { data: theme ?? {} });
}

async function open(page: Page): Promise<void> {
  await page.goto("/90-merchant.html");
  await page.waitForFunction(() => typeof (window as { Sky?: unknown }).Sky === "object");
  await page.click("#help");
  await expect(page.frameLocator(CONSENT).locator("#ask")).toBeVisible();
}

test.afterEach(async ({ page }) => {
  await withTheme(page, null);
});

test("a brand colour reaches the button, with a label colour chosen for it", async ({ page }) => {
  await withTheme(page, { accent: "#0b3d91", radius: 4 });
  await open(page);

  const allow = page.frameLocator(CONSENT).locator("#allow");
  const style = await allow.evaluate((node) => {
    const computed = getComputedStyle(node);
    return {
      background: computed.backgroundColor,
      color: computed.color,
      radius: computed.borderTopLeftRadius
    };
  });
  expect(style.background).toBe("rgb(11, 61, 145)");
  expect(style.color).toBe("rgb(255, 255, 255)");
  expect(style.radius).toBe("4px");
});

test("a pale brand colour keeps its button findable", async ({ page }) => {
  await withTheme(page, { accent: "#fdfdfd", scheme: "light" });
  await open(page);

  const allow = page.frameLocator(CONSENT).locator("#allow");
  const style = await allow.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { background: computed.backgroundColor, border: computed.borderTopColor, color: computed.color };
  });
  // Their colour, their black label — and a derived border so the control has an edge
  // against a white card instead of vanishing into it.
  expect(style.background).toBe("rgb(253, 253, 253)");
  expect(style.color).toBe("rgb(0, 0, 0)");
  expect(style.border).not.toBe(style.background);
});

test("a hostile theme changes nothing except the console warning", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });

  await withTheme(page, {
    // Every one of these is an attempt to close a declaration and open another, or to reach
    // the network, or to substitute the glyphs the customer reads.
    accent: "#fff; } .stop, #deny { display: none !important } .x {",
    font: "url(https://evil.test/swapped-glyphs.woff2)",
    radius: 99999,
    scheme: "invisible"
  });
  await open(page);

  const panel = page.frameLocator(CONSENT);
  // The refusal is still there and still the same size. This is the assertion that matters:
  // a theme may not be a way to remove the answer a merchant does not want.
  await expect(panel.locator("#deny")).toBeVisible();
  const deny = await panel.locator("#deny").boundingBox();
  expect(deny!.height).toBeGreaterThanOrEqual(40);

  const style = await panel.locator("#allow").evaluate((node) => {
    const computed = getComputedStyle(node);
    return { background: computed.backgroundColor, radius: computed.borderTopLeftRadius };
  });
  // Fell back to ours rather than to nothing.
  expect(style.background).toBe("rgb(11, 79, 216)");
  // Clamped, not honoured.
  expect(parseFloat(style.radius)).toBeLessThanOrEqual(12);

  // And the merchant is told, in their own console, rather than watching a setting do
  // nothing for no stated reason.
  expect(warnings.join("\n")).toContain("consent theme");
  expect(warnings.join("\n")).toContain("accent");
  expect(warnings.join("\n")).toContain("font");
});

test("a forced scheme changes the panel and nothing else", async ({ page }) => {
  await withTheme(page, { scheme: "dark" });
  await open(page);

  const panel = page.frameLocator(CONSENT);
  const card = await panel.locator(".card").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(card).toBe("rgb(22, 27, 33)");

  // Legibility survives the scheme: the terms are still readable against the card they are
  // printed on, which is the property a merchant could otherwise destroy.
  const scope = await panel.locator("#scope").evaluate((node) => getComputedStyle(node).color);
  expect(scope).not.toBe(card);

  // And both answers are still there, still full size.
  for (const control of ["#allow", "#deny"]) {
    const box = await panel.locator(control).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
  }
});

test("the wording is not themeable", async ({ page }) => {
  await withTheme(page, {
    accent: "#0b3d91",
    // There is no token for this, so it is simply ignored — but a future one would have to
    // walk past this test.
    text: "Click OK to continue",
    scopeText: "Nothing will be shared"
  } as unknown);
  await open(page);
  await expect(page.frameLocator(CONSENT).locator("#scope")).toContainText("can see and use this page");
  await expect(page.frameLocator(CONSENT).locator("#allow")).toHaveText("Allow");
  await expect(page.frameLocator(CONSENT).locator("#deny")).toHaveText("Not now");
});
