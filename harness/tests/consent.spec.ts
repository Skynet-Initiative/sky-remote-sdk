/**
 * The consent surface, in a real browser, on a phone and on a laptop.
 *
 * The defect that motivated this file: the iframe was created with `height: auto`, which
 * for a replaced element means the browser's default 150px, so the card was cropped and
 * the Allow button sat below the fold. Unclickable consent, in front of a real customer.
 * A single automated page load would have caught it — this is that page load, and it now
 * runs at both sizes because the failure was size-dependent.
 *
 * Every assertion here is about the two things a customer must always be able to do:
 * **read what they are agreeing to**, and **stop**.
 */

import { expect, test, type Page } from "@playwright/test";
import { CONSENT, ask, goLive, panel } from "./support.js";

/** Fully inside the viewport, big enough to hit, and actually on top of the stack. */
async function expectUsable(page: Page, selector: string): Promise<void> {
  const control = panel(page).locator(selector);
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${selector} has no box`).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.y, `${selector} starts above the viewport`).toBeGreaterThanOrEqual(0);
  expect(box!.x, `${selector} starts left of the viewport`).toBeGreaterThanOrEqual(0);
  expect(
    box!.y + box!.height,
    `${selector} is cropped: it ends at ${Math.round(box!.y + box!.height)} in a ${viewport.height}px viewport`
  ).toBeLessThanOrEqual(viewport.height);
  expect(box!.x + box!.width, `${selector} runs off the right edge`).toBeLessThanOrEqual(viewport.width);
  // 44px is the smallest reliably tappable target, and these are the two most
  // consequential buttons in the product.
  expect(box!.height, `${selector} is only ${Math.round(box!.height)}px tall`).toBeGreaterThanOrEqual(40);
  await expect(control).toBeEnabled();
}

test("the ask is readable and both answers are reachable", async ({ page }) => {
  await ask(page);

  // The signed text, verbatim — not a summary of it.
  await expect(panel(page).locator("#scope")).toContainText("can see and use this page");
  await expect(panel(page).locator("#ask-title")).toBeVisible();
  // The origin the browser reported, which is the one fact the customer can check against
  // their own address bar and no integrator can forge.
  await expect(panel(page).locator("#origin")).toHaveText("http://localhost:4180");

  await expectUsable(page, "#allow");
  await expectUsable(page, "#deny");
});

test("a long consent text scrolls the body rather than pushing the buttons out", async ({ page }) => {
  await ask(page);

  // Twenty times the longest scope text the engine could produce.
  await panel(page)
    .locator("#scope")
    .evaluate((node) => {
      node.textContent = "This is a very long consent paragraph. ".repeat(120);
    });
  await page.waitForTimeout(200);

  // The body took the growth, which is the whole of the layout rule: the card is a
  // fixed-height column and only the middle of it scrolls.
  const scrolls = await panel(page)
    .locator("#body")
    .evaluate((node) => node.scrollHeight > node.clientHeight + 4);
  expect(scrolls, "the body did not scroll, so the growth went somewhere else").toBe(true);
  await expectUsable(page, "#allow");
  await expectUsable(page, "#deny");
});

test("consent goes live and the stop control is reachable from then on", async ({ page }) => {
  await goLive(page);
  await expectUsable(page, "#stop");
  // The customer can narrow without asking anyone, because the offer was for control.
  await expectUsable(page, "#view-only");

  const events = await page.evaluate(() => (window as unknown as { __events: { name: string }[] }).__events);
  expect(events.map((e) => e.name)).toContain("consented");

  // And the indicator does not cover the page it sits beside.
  const box = await page.locator(CONSENT).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.height, "the live indicator is covering the page").toBeLessThan(viewport.height / 2);

  await panel(page).locator("#stop").click();
  await expect(panel(page).locator("#over")).toBeVisible();
});

/**
 * The indicator's box is small — and so is everything it paints.
 *
 * `boundingBox` above was true and insufficient. The scrim is a `::backdrop`, which has no
 * box of its own and covers the whole viewport, and the rule that drew it named no state:
 * `dialog[data-sky-consent]::backdrop`. `::backdrop` is not the modal's alone — anything in
 * the top layer renders it, and the indicator is a popover in the top layer — so a customer
 * who granted control watched their own site sit behind a dark `blur(2px)` for the length of
 * the session, with the card's rounded corners painted dark by the same rectangle.
 *
 * Asserted on the computed pseudo-element rather than on a screenshot, because that is the
 * declaration that was wrong and a pixel diff of "slightly darker" is exactly the kind of
 * difference a reviewer waves through.
 */
test("the scrim belongs to the ask and is gone the moment the session is live", async ({
  page
}) => {
  const backdrop = () =>
    page.evaluate(() => {
      const host = document.querySelector("dialog[data-sky-consent]");
      if (!host) return null;
      const bd = getComputedStyle(host, "::backdrop");
      return {
        surface: host.getAttribute("data-sky-surface"),
        background: bd.backgroundColor,
        filter: bd.backdropFilter || "none"
      };
    });

  await ask(page);
  // The ask is modal and dims the page deliberately: it is a decision, not a badge.
  const asking = await backdrop();
  expect(asking?.surface).toBe("ask");
  expect(asking?.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(asking?.filter).toContain("blur");

  await panel(page).locator("#allow").click();
  await expect(panel(page).locator("#live")).toBeVisible();

  const live = await backdrop();
  expect(live?.surface, "the host still says it is asking").not.toBe("ask");
  expect(live?.background, "the page is still dimmed during the session").toBe("rgba(0, 0, 0, 0)");
  expect(live?.filter, "the page is still blurred during the session").toBe("none");
});

/**
 * Nothing opaque behind the card, in either scheme.
 *
 * `:root` sets `color-scheme: light dark` so the browser's own scrollbars and controls match
 * the panel. That also makes the user agent paint the document's canvas instead of leaving it
 * transparent — and the canvas is the *frame's* rectangle, while the card inside it is rounded.
 * Only `body` had been made transparent, which is not where the canvas comes from.
 */
test("the indicator card has nothing square painted behind it", async ({ page }) => {
  await goLive(page);

  const inner = await panel(page)
    .locator("body")
    .evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      radius: getComputedStyle(document.querySelector(".card")!).borderRadius
    }));

  const transparent = "rgba(0, 0, 0, 0)";
  expect(inner.html, "the frame's canvas is opaque behind a rounded card").toBe(transparent);
  expect(inner.body).toBe(transparent);
  // The card is what carries the corners, so if it ever stops being rounded the test above
  // would pass while the panel looked wrong.
  expect(inner.radius).not.toBe("0px");
});

test("scrolling the merchant's page cannot scroll the panel away", async ({ page }) => {
  await ask(page);
  await page.mouse.wheel(0, 1800);
  await page.waitForTimeout(200);
  await expectUsable(page, "#allow");
});

test("keyboard alone can read and refuse", async ({ page }) => {
  await ask(page);
  // Focus lands on the heading, not on the affirmative button: a default focus on Allow is
  // one Enter away from consent nobody read.
  const focused = await panel(page).locator("#ask-title").evaluate((n) => n === document.activeElement);
  expect(focused).toBe(true);

  // Tab reaches the controls and cycles inside the card rather than escaping into the
  // browser's chrome on the first press.
  const onDeny = await panel(page)
    .locator("#deny")
    .evaluate((n) => {
      n.focus();
      return n === document.activeElement;
    });
  expect(onDeny).toBe(true);

  await panel(page).locator("#deny").press("Enter");
  await expect(panel(page).locator("#over")).toBeVisible();
  await expect(panel(page).locator("#over-detail")).toContainText("Nothing was shared");
});

test("Escape declines and never silently closes the panel", async ({ page }) => {
  await ask(page);
  // A modal `<dialog>` closes itself on Escape. A consent panel that vanishes on a keypress
  // is worse than one that never appeared, because the customer believes they dismissed it
  // while the session sits waiting — so the host cancels the cancel and the frame treats
  // Escape as "not now".
  await panel(page).locator("#deny").press("Escape");
  await expect(panel(page).locator("#over")).toBeVisible();
  await expect(panel(page).locator("#over-detail")).toContainText("Nothing was shared");
  await expect(page.locator(CONSENT)).toBeVisible();
});

test("the panel carries the roles and labels a screen reader needs", async ({ page }) => {
  await ask(page);
  const a11y = await panel(page).locator("#shell").evaluate((node) => ({
    role: node.getAttribute("role"),
    modal: node.getAttribute("aria-modal"),
    labelled: node.getAttribute("aria-labelledby"),
    described: node.getAttribute("aria-describedby"),
    lang: document.documentElement.lang
  }));
  expect(a11y.role).toBe("dialog");
  expect(a11y.modal).toBe("true");
  expect(a11y.labelled).toBe("ask-title");
  expect(a11y.described).toBe("scope");

  // Every state change is announced, because a customer who cannot see the dot has to be
  // told that someone started watching.
  await panel(page).locator("#allow").click();
  await expect(panel(page).locator("#announce")).toContainText("Sharing started");
});

test.describe("a page that fights the panel", () => {
  test("cannot unpin it with `iframe { position: static !important }`", async ({ page }) => {
    await ask(page, "91-hostile.html");
    // The hostile stylesheet forces every iframe to 10px, static. Every declaration on the
    // host and the frame is `!important` and the host is a top-layer dialog, so it holds.
    await expectUsable(page, "#allow");
  });

  test("cannot cover it, and covering it stops the session", async ({ page }) => {
    await ask(page, "91-hostile.html");
    await panel(page).locator("#allow").click();
    await expect(panel(page).locator("#live")).toBeVisible();

    await page.evaluate(() => (window as unknown as { __cover: () => void }).__cover());
    await page.waitForTimeout(900);

    const events = await page.evaluate(
      () => (window as unknown as { __events: { name: string; detail: unknown }[] }).__events
    );
    // Either the top layer kept it on top — in which case nothing was covered — or the
    // occlusion check fired. What may NOT happen is the session continuing behind an
    // overlay with no reachable stop control.
    const covered = events.some((e) => e.name === "obscured");
    const onTop = await page.evaluate(() => {
      const host = document.querySelector("dialog[data-sky-consent]") as HTMLElement | null;
      if (!host) return false;
      const r = host.getBoundingClientRect();
      const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return stack[0] === host || host.contains(stack[0]!);
    });
    expect(covered || onTop, "the panel was covered and nothing noticed").toBe(true);
  });

  test("fading an ancestor pauses the stream", async ({ page }) => {
    await ask(page, "91-hostile.html");
    await panel(page).locator("#allow").click();
    await expect(panel(page).locator("#live")).toBeVisible();

    await page.evaluate(() => (window as unknown as { __fade: () => void }).__fade());
    await page.waitForTimeout(900);

    const events = await page.evaluate(
      () => (window as unknown as { __events: { name: string }[] }).__events
    );
    expect(events.map((e) => e.name), "an ancestor at 0.4 opacity went unnoticed").toContain("obscured");
  });

  /**
   * Moving the panel destroys it, and the geometry watch cannot see that.
   *
   * Re-parenting a `<dialog>` re-creates the iframe inside it: the browser reloads the
   * document, which discards the session's non-extractable private key, its socket and its
   * consent state, and — measured — leaves `contentDocument` permanently unreachable. What
   * remains is a rectangle with no stop control and no indicator.
   *
   * **Every geometry check passed while this was true.** The dialog is the right size, on top
   * of the hit-test stack, fully opaque, connected. The watch measures the container, and the
   * container was never the thing that broke. Before the fix the session went to `paused` with
   * no event at all, so nothing told the integrator and nothing told the customer.
   *
   * Not necessarily an attack — a framework that re-parents nodes on re-render does this by
   * accident, which is the likelier way to meet it.
   */
  test("re-parenting the panel is noticed, and is not recovered from", async ({ page }) => {
    await ask(page, "91-hostile.html");
    await panel(page).locator("#allow").click();
    await expect(panel(page).locator("#live")).toBeVisible();

    await page.evaluate(() => {
      const host = document.querySelector("dialog[data-sky-consent]")!;
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;inset:0";
      document.body.appendChild(box);
      box.appendChild(host);
    });
    await page.waitForTimeout(1500);

    const events = await page.evaluate(
      () => (window as unknown as { __events: { name: string; detail: { reason?: string } }[] }).__events
    );
    const names = events.map((e) => e.name);
    expect(names, "the panel was destroyed and nothing said so").toContain("obscured");
    expect(
      events.find((e) => e.name === "obscured")?.detail?.reason,
      "reported as an occlusion rather than as the loss it is"
    ).toBe("surface-lost");

    // Terminal. The dialog is in perfect condition, so the next poll would find no problem and
    // report `visible` — resuming the stream to a panel with no stop control in it, which is
    // worse than never having noticed. Nothing brings a reloaded frame back.
    expect(names, "the panel was declared recovered; it cannot be").not.toContain("visible");
    expect(await page.evaluate(() => (window as unknown as { Sky: { state: string } }).Sky.state)).toBe(
      "paused"
    );
  });
});
