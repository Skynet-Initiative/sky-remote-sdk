/**
 * Budgets, so the costs that were fixed stay fixed.
 *
 * Every other spec here asserts what the mirror *renders* or what goes on the wire. Nothing
 * measured how much work was done to get there — so a serializer that walked the ancestry of
 * every node four times, a mutation observer that emitted an empty frame twenty times a second,
 * and a relay that copied every frame twice per viewer all passed the suite for months.
 *
 * That is not hypothetical. `BUILD-LOG.md` records "the serializer walked the same ancestry up
 * to four times per field" as fixed, and the call count it names was unchanged in the code until
 * this pass, because nothing was watching.
 *
 * ## These are budgets, not benchmarks
 *
 * Wall-clock on a CI runner is noise. What is asserted here is *counted work* — how many times
 * an expensive DOM API was called, and how many frames were sent — which is deterministic for a
 * fixed corpus page and does not care how loaded the machine is. The thresholds are set well
 * above what the code does now: they exist to catch a regression of the order of magnitude these
 * bugs actually had (4×, 20 frames/second), not to pin an exact number that would make every
 * unrelated change a failing test.
 *
 * If one of these fails, the question is "what started doing N times more work", not "can I
 * raise the number".
 */

import { expect, test } from "@playwright/test";
import { goLive, loadProbe } from "./support.js";

const SIGNAL = "ws://localhost:4182";

declare global {
  interface Window {
    __counts?: { matches: number; elementFromPoint: number; getComputedStyle: number };
    __frames?: string[];
  }
}

/**
 * Count the DOM calls the privacy verdict and the chokepoint depend on.
 *
 * `Element.matches` is the one that mattered: the verdict walks to `<html>` testing every
 * `mask` selector at each level, and it used to run eagerly for every element **and** every text
 * node in a snapshot.
 */
async function instrument(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    window.__counts = { matches: 0, elementFromPoint: 0, getComputedStyle: 0 };
    const matches = Element.prototype.matches;
    Element.prototype.matches = function (this: Element, s: string) {
      window.__counts!.matches++;
      return matches.call(this, s);
    };
    const efp = Document.prototype.elementFromPoint;
    Document.prototype.elementFromPoint = function (this: Document, x: number, y: number) {
      window.__counts!.elementFromPoint++;
      return efp.call(this, x, y);
    };
    const gcs = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((el: Element, pe?: string | null) => {
      window.__counts!.getComputedStyle++;
      return gcs(el, pe ?? undefined);
    }) as typeof window.getComputedStyle;
  });
}

test("a snapshot does not re-derive the privacy verdict for every node", async ({ page }) => {
  await instrument(page);
  // The SPA corpus is the largest in the set and the one a real page most resembles.
  await loadProbe(page, "05-spa.html");

  const counts = await page.evaluate(() => {
    const before = window.__counts!.matches;
    window.__sky.snapshot();
    return { spent: window.__counts!.matches - before, nodes: document.querySelectorAll("*").length };
  });

  // Eagerly, this was one full ancestor climb per element and per text node, each testing every
  // selector in `mask` — comfortably more than ten `matches` per element on a nested page. The
  // budget is deliberately generous; the regression it catches is the order of magnitude.
  expect(counts.nodes).toBeGreaterThan(20);
  expect(counts.spent / counts.nodes).toBeLessThan(6);
});

test("typing does not reclassify the field three times per keystroke", async ({ page }) => {
  await instrument(page);
  await loadProbe(page, "07-sensitive-fields.html");

  const perKeystroke = await page.evaluate(() => {
    // The chokepoint fails closed on nodes the serializer has not seen.
    window.__sky.snapshot();
    const field = document.querySelector("input") as HTMLInputElement;
    // Warm first: what is being measured is the steady state of holding a key down, which is
    // the path `stream.ts`'s `input` listener takes — `attributesFor` on the typed field.
    window.__sky.serializer.attributesFor(field);
    const before = window.__counts!.matches;
    for (let i = 0; i < 10; i++) window.__sky.serializer.attributesFor(field);
    return (window.__counts!.matches - before) / 10;
  });

  // One `attributesFor` asked `isMaskedField` three times — directly, through `textLegible`'s
  // field branch, and again for the live value — each an independent climb.
  expect(perKeystroke).toBeLessThan(12);
});

test("an agent pointer event hit-tests the page once", async ({ page }) => {
  await instrument(page);
  await loadProbe(page, "90-merchant.html");

  const perEvent = await page.evaluate(() => {
    window.__sky.snapshot();
    window.__sky.dispatch(0.5, 0.5);
    const before = window.__counts!.elementFromPoint;
    for (let i = 0; i < 10; i++) window.__sky.dispatch(0.5, 0.5);
    return (window.__counts!.elementFromPoint - before) / 10;
  });

  // Two, once: `representability` resolved the coordinate and `dispatch` resolved it again.
  // Each one forces a style and layout flush on the customer's device, at pointer rate.
  expect(perEvent).toBeLessThanOrEqual(1);
});

test("a live session sends no empty mirror frames while an agent points", async ({ page }) => {
  // The full flow, not the probe: this bug only exists when the shipped bundle's own
  // `MutationObserver` is running against the shipped `Presence` overlay, and `window.__sky` is
  // the probe's API, which a `goLive` page does not have. The first version of this test called
  // `window.__sky?.presence?.show(...)`, which optional-chained to nothing and left no overlay —
  // caught by the assertion below rather than passing silently, which is why it is there.
  await goLive(page);
  await page.waitForTimeout(400);
  const session = await page.evaluate(() => {
    const events = (window as unknown as { __events: { name: string; detail?: { session?: string } }[] })
      .__events;
    return events.find((e) => e.name === "invited")?.detail?.session ?? null;
  });
  expect(session, "the page never reported an invited session").not.toBeNull();

  // An agent socket, as the console holds one.
  await page.evaluate(
    ([signal, id]) => {
      const socket = new WebSocket(signal);
      (window as unknown as { __agent: { socket: WebSocket } }).__agent = { socket };
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ type: "hello", role: "agent", session: id, token: "tok_harness" }))
      );
    },
    [SIGNAL, session] as const
  );
  // The relay announces presence on attach and the SDK re-snapshots when the agent count rises.
  // Let that settle, or the snapshot it triggers is counted as traffic this test caused.
  await page.waitForTimeout(600);

  // Capture what actually reaches the socket, after the settling above.
  await page.evaluate(() => {
    window.__frames = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string) {
      if (typeof data === "string") window.__frames!.push(data);
      return send.call(this, data);
    };
  });

  // Drive the overlay the way production does: inbound cursor frames from the agent. Each one
  // rewrites the overlay's transform, the overlay lives in the observed subtree, and it is
  // deliberately never serialized — so every mutation record it produces is dropped.
  for (let i = 0; i < 20; i++) {
    await page.evaluate(
      ([cx, cy]) => {
        const { socket } = (window as unknown as { __agent: { socket: WebSocket } }).__agent;
        socket.send(JSON.stringify({ type: "presence.cursor", cursor: { x: cx, y: cy } }));
      },
      [0.3 + i * 0.01, 0.4 + i * 0.01] as const
    );
    await page.waitForTimeout(60);
  }

  // **Asserted, not assumed.** Without the overlay nothing is dropped, the loop above mutates
  // nothing, and this test would pass by doing nothing — the exact failure mode it exists to
  // catch. Checked after the loop because the overlay is created by the first inbound cursor.
  await expect(page.locator("[data-sky-presence]").first()).toBeAttached();

  const empties = await page.evaluate(() =>
    (window.__frames ?? []).filter((f) => {
      if (!f.includes('"op":"mutate"')) return false;
      try {
        const d = JSON.parse(f).data;
        return (
          !d.adds?.length && !d.removes?.length && !d.attrs?.length &&
          !d.texts?.length && !d.scrolls?.length
        );
      } catch {
        return false;
      }
    }).length
  );

  expect(empties).toBe(0);
});
