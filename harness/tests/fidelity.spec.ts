/**
 * The S-8 corpus, run against the serializer and the rebuilder together.
 *
 * the v1 scope asks for five third-party applications chosen
 * for the properties that break DOM serialization, re-run on every serializer change.
 * There were none, which is why fidelity failed on the first real site it met.
 *
 * The comparison is **computed style and geometry**, not pixels. Two reasons: a pixel diff
 * on a headless browser fails on font hinting and passes on a page that is subtly wrong,
 * and "the customer's page renders with the wrong background and no border" is exactly a
 * computed-style difference. The original and the mirror are measured in the **same
 * browser, in the same page**, so any difference is one the contract introduced.
 */

import { expect, test, type Page } from "@playwright/test";
import { loadProbe } from "./support.js";

interface Measurement {
  rect: { x: number; y: number; w: number; h: number };
  style: Record<string, string>;
  text: string;
  opaque: string | null;
}

/**
 * These tests run on the real shipping configuration.
 *
 * The helper they used to call **defaulted to `unmask: ["html"]`** — the whole document opted out
 * of masking — because default-on masking replaced every glyph with a bullet and the comparison
 * could not see past it. That workaround was the design telling us something: a privacy policy the
 * test suite has to switch off to measure anything is a policy no merchant can run in production
 * either. `privacy.ts` has the measurements that followed, and tier-specific behaviour now lives
 * in `privacy.spec.ts`.
 */

/**
 * Serialize the page, rebuild it into an iframe of exactly the customer's viewport, and
 * measure both.
 *
 * The iframe is sized to the snapshot's own viewport rather than to whatever space the
 * console has. That is the "does not reflow the customer's layout into a different one"
 * requirement, and corpus #6 fails without it: its grid is two columns at 1440px and one
 * at 500px, so a mirror rendered at panel width shows a layout that never existed on the
 * customer's screen.
 */
async function mirrorAndMeasure(page: Page): Promise<{
  original: Record<string, Measurement>;
  mirrored: Record<string, Measurement>;
}> {
  return page.evaluate(async () => {
    const snapshot = window.__sky.snapshot();
    const original = window.__sky.measure(document);

    const frame = document.createElement("iframe");
    frame.id = "sky-test-mirror";
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.style.cssText =
      `position:fixed;left:0;top:0;border:0;width:${snapshot.viewport.w}px;` +
      `height:${snapshot.viewport.h}px;visibility:hidden`;
    document.documentElement.appendChild(frame);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    window.__sky.rebuild(frame, snapshot);
    // Give the mirror's own stylesheets a turn to apply before measuring.
    await new Promise((r) => setTimeout(r, 400));
    const mirrored = window.__sky.measure(frame.contentDocument!);
    frame.remove();
    return { original, mirrored };
  });
}

/** Geometry within a pixel, and every watched property identical. */
function expectFaithful(
  original: Record<string, Measurement>,
  mirrored: Record<string, Measurement>,
  options: { skip?: string[] } = {}
): void {
  const skip = new Set(options.skip ?? []);
  expect(Object.keys(mirrored).sort()).toEqual(Object.keys(original).sort());
  for (const [probe, want] of Object.entries(original)) {
    const got = mirrored[probe];
    expect(got, `probe "${probe}" is missing from the mirror`).toBeTruthy();
    // A region the mirror marked inert is striped deliberately. Its colours are supposed
    // to differ; its box is not, because an inert region that changed the layout around it
    // would move everything the agent is looking at.
    if (!got!.opaque) {
      for (const [property, value] of Object.entries(want.style)) {
        if (skip.has(property)) continue;
        expect(got!.style[property], `${probe} · ${property}`).toBe(value);
      }
    }
    expect(Math.abs(got!.rect.w - want.rect.w), `${probe} · width`).toBeLessThanOrEqual(1);
    expect(Math.abs(got!.rect.h - want.rect.h), `${probe} · height`).toBeLessThanOrEqual(1);
    expect(Math.abs(got!.rect.x - want.rect.x), `${probe} · x`).toBeLessThanOrEqual(1);
    expect(Math.abs(got!.rect.y - want.rect.y), `${probe} · y`).toBeLessThanOrEqual(1);
  }
}

test.describe("S-8 corpus", () => {
  test("#1 external stylesheet, @import and stylesheet-relative url()", async ({ page }) => {
    await loadProbe(page, "01-external-stylesheet.html");
    const { original, mirrored } = await mirrorAndMeasure(page);
    expectFaithful(original, mirrored);

    // The specific failure that started this phase: not merely "some CSS applied" but the
    // linked sheet, the sheet it imports, and a url() that resolves against the sheet.
    expect(original.card!.style["border-top-color"]).toBe("rgb(29, 111, 216)");
    expect(mirrored.card!.style["border-top-color"]).toBe("rgb(29, 111, 216)");
    expect(mirrored.badge!.style["background-color"]).toBe("rgb(13, 138, 69)");
    expect(mirrored.hero!.style["background-image"]).toContain("swatch.svg");
    // Resolved against the stylesheet's directory, not the document root.
    expect(mirrored.hero!.style["background-image"]).toContain("/assets/swatch.svg");
  });

  test("#2 CSS-in-JS: rules inserted through the CSSOM, including after the snapshot", async ({
    page
  }) => {
    await loadProbe(page, "02-css-in-js.html");
    const { original, mirrored } = await mirrorAndMeasure(page);
    expectFaithful(original, mirrored);
    // The `<style>` element's text node is empty; everything visible came from the CSSOM.
    expect(await page.evaluate(() => document.getElementById("runtime")!.textContent)).toBe("");
    expect(mirrored.cta!.style["background-color"]).toBe("rgb(91, 155, 255)");
  });

  /**
   * A rule edited in place, which no mutation record and no rule count reports.
   *
   * `insertRule` above changes `cssRules.length`, which is what the old change detector keyed
   * on. Editing an existing rule — `rule.style.setProperty`, which is what a theme switcher, an
   * animation library and most CSS-in-JS updates do — changes nothing it was looking at, so the
   * agent watched the customer switch to dark mode and saw the page not change.
   *
   * Asserted through a full serialize-and-rebuild rather than on the detector, so it is the
   * *outcome* that is pinned: whatever signature the stream uses, this edit has to reach the
   * mirror.
   */
  test("#2b CSS-in-JS: a rule edited in place still reaches the mirror", async ({ page }) => {
    await loadProbe(page, "02-css-in-js.html");
    await page.evaluate(() => (window as unknown as { editRuleInPlace: () => void }).editRuleInPlace());
    const { original, mirrored } = await mirrorAndMeasure(page);
    expectFaithful(original, mirrored);
    expect(original.title!.style["color"]).toBe("rgb(255, 0, 128)");
    expect(mirrored.title!.style["color"], "the in-place edit never reached the mirror").toBe(
      "rgb(255, 0, 128)"
    );
  });

  test("#3 constructed stylesheets adopted by the document", async ({ page }) => {
    await loadProbe(page, "03-adopted-stylesheets.html");
    const { original, mirrored } = await mirrorAndMeasure(page);
    expectFaithful(original, mirrored);
    expect(mirrored.pill!.style["background-color"]).toBe("rgb(11, 79, 216)");
    expect(mirrored.shell!.style["border-radius"]).toBe("18px");
  });

  test("#4 opaque regions are marked, empty and inert", async ({ page }) => {
    await loadProbe(page, "04-opaque-regions.html");
    const reasons = await page.evaluate(() => {
      const snapshot = window.__sky.snapshot();
      const found: Record<string, { reason?: string; children: number }> = {};
      const walk = (node: import("../../protocol/src/index.js").MirrorNode): void => {
        if (node.t === "el" && node.a?.["data-probe"]) {
          found[node.a["data-probe"]] = { reason: node.o, children: (node.c ?? []).length };
        }
        for (const child of node.c ?? []) walk(child);
      };
      walk(snapshot.root);
      return found;
    });

    // Every shadow host, open or closed. An earlier version marked only closed roots on
    // custom elements, so every open shadow host was a blind-click region.
    expect(reasons["open-shadow"]!.reason).toBe("closed-shadow-root");
    expect(reasons["closed-shadow"]!.reason).toBe("closed-shadow-root");
    expect(reasons["canvas"]!.reason).toBe("canvas");
    expect(reasons["frame"]!.reason).toBe("cross-origin-frame");
    // A `type="password"` field: masked by the classifier, in every tier, unconditionally.
    expect(reasons["masked"]!.reason).toBe("masked");
    // And the field beside it is NOT. This assertion used to read `toBe("masked")` with the
    // comment "masking is default-on", which is the behaviour the privacy rework removed: an
    // ordinary text input holding a customer's name was opaque, so the agent could neither
    // read it nor type into it. `privacy.ts` has the measurements. What replaced it is
    // detection — the password next door is still masked, this one is not.
    expect(reasons["clear"]!.reason).toBeUndefined();
    expect(reasons["button"]!.reason).toBeUndefined();

    for (const probe of ["open-shadow", "closed-shadow", "canvas", "frame"]) {
      expect(reasons[probe]!.children, `${probe} must have no children`).toBe(0);
    }

    // And nothing an opaque node carries can make the console fetch a third party.
    const frameHasSrc = await page.evaluate(() => {
      const snapshot = window.__sky.snapshot();
      let src: string | undefined;
      const walk = (node: import("../../protocol/src/index.js").MirrorNode): void => {
        if (node.a?.["data-probe"] === "frame") src = node.a["src"];
        for (const child of node.c ?? []) walk(child);
      };
      walk(snapshot.root);
      return src;
    });
    expect(frameHasSrc).toBeUndefined();
  });

  test("#5 SPA: late renders, element scroll, live values and a late stylesheet", async ({
    page
  }) => {
    await loadProbe(page, "05-spa.html");
    await page.evaluate(() => {
      (window as unknown as { renderList: (n: number) => void }).renderList(24);
      document.getElementById("panel")!.scrollTop = 120;
      (document.getElementById("q") as HTMLInputElement).value = "4417";
      (window as unknown as { loadLateStylesheet: () => void }).loadLateStylesheet();
    });
    await page.waitForTimeout(300);

    const { original, mirrored } = await mirrorAndMeasure(page);
    expectFaithful(original, mirrored);

    // A panel scrolled away from its origin. No observer reports this, so a serializer
    // that does not read it shows the agent a different page from the one being read.
    const scroll = await page.evaluate(() => {
      const snapshot = window.__sky.snapshot();
      return snapshot.scrolls;
    });
    expect(scroll.some((s) => s.y === 120)).toBe(true);

    // A field's live value is a property, not an attribute: an attribute copy shows the
    // agent the page's initial state instead of what the customer typed.
    const fieldValue = await page.evaluate(() => {
      const snapshot = window.__sky.snapshot();
      let value: string | undefined;
      const walk = (node: import("../../protocol/src/index.js").MirrorNode): void => {
        if (node.a?.["data-probe"] === "field") value = node.a["value"];
        for (const child of node.c ?? []) walk(child);
      };
      walk(snapshot.root);
      return value;
    });
    expect(fieldValue).toBe("4417");
  });

  test("#6 form state that lives in properties, at the customer's viewport", async ({ page }) => {
    await loadProbe(page, "06-forms-and-frames.html");
    const { original, mirrored } = await mirrorAndMeasure(page);
    expectFaithful(original, mirrored);

    const state = await page.evaluate(() => {
      const frame = document.createElement("iframe");
      const snapshot = window.__sky.snapshot();
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.style.cssText = `position:fixed;left:0;top:0;width:${snapshot.viewport.w}px;height:${snapshot.viewport.h}px;visibility:hidden`;
      document.documentElement.appendChild(frame);
      window.__sky.rebuild(frame, snapshot);
      const doc = frame.contentDocument!;
      const out = {
        checked: (doc.getElementById("express") as HTMLInputElement).checked,
        selected: (doc.getElementById("method") as HTMLSelectElement).value,
        note: (doc.querySelector('[data-probe="note"]') as HTMLTextAreaElement).value,
        // An email address, which the agent is allowed to read — see below.
        email: (doc.getElementById("email") as HTMLInputElement).value
      };
      frame.remove();
      return out;
    });
    expect(state.checked).toBe(true);
    expect(state.selected).toBe("sepa");
    expect(state.note).toBe("Leave with the concierge");
    // Readable, and this assertion is the inverse of what it used to be.
    //
    // `email` was in the serializer's unconditional mask set, so this expected fifteen
    // bullets. It was the wrong call: an email address is the single most common thing a
    // support agent legitimately needs to read back — "can you confirm the address on the
    // account?" — and masking it protected almost nothing, because the agent is already
    // talking to the customer about the account it identifies. The old assertion encoded the
    // paranoia rather than a requirement.
    //
    // `password` and `tel` remain unconditional; `privacy.ts` says why each stayed.
    expect(state.email).toBe("jane@example.fr");
  });
});

test("the media query resolves at the customer's width, not the console's", async ({ page }) => {
  await loadProbe(page, "06-forms-and-frames.html");
  const { atCustomerWidth, atPanelWidth, original } = await page.evaluate(async () => {
    const snapshot = window.__sky.snapshot();
    const grid = document.querySelector('[data-probe="grid"]')!;
    const original = getComputedStyle(grid).gridTemplateColumns;

    const render = async (width: number): Promise<string> => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${snapshot.viewport.h}px;visibility:hidden`;
      document.documentElement.appendChild(frame);
      window.__sky.rebuild(frame, snapshot);
      await new Promise((r) => setTimeout(r, 200));
      const value = frame.contentWindow!.getComputedStyle(
        frame.contentDocument!.querySelector('[data-probe="grid"]')!
      ).gridTemplateColumns;
      frame.remove();
      return value;
    };

    return {
      original,
      atCustomerWidth: await render(snapshot.viewport.w),
      // What a console that fits the mirror to its own panel would show.
      atPanelWidth: await render(360)
    };
  });

  // Rendered at the customer's viewport, the layout is theirs.
  expect(atCustomerWidth).toBe(original);
  // And the width is not incidental: the same snapshot in a narrower box produces a
  // layout that never existed on their screen, which is what "fit without reflowing"
  // exists to prevent. The console scales; it does not resize.
  expect(atPanelWidth).not.toBe(atCustomerWidth);
});
