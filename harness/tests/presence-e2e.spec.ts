/**
 * Presence end to end: the real SDK bundle, a real socket, a real relay, both directions.
 *
 * `presence.spec.ts` drives the SDK's `Presence` class directly, which is the right shape for
 * asserting what leaves the browser. It cannot catch anything in the *wiring* — a frame the SDK
 * never sends because `applyCapability` forgot to start the loop, an inbound frame the SDK
 * drops because the handler names the wrong type, an identity the relay fails to stamp. Those
 * are exactly the defects that survive a green unit suite and show up the first time someone
 * demos the product.
 *
 * So this runs the **shipped bundle** on a merchant page, through consent, and puts a real
 * agent socket on the other end:
 *
 *  - **customer → agent**: move the mouse on the merchant's page, read the frame off the
 *    agent's socket;
 *  - **agent → customer**: send a cursor down the agent's socket, find the overlay on the
 *    merchant's page with the label the relay stamped on it.
 *
 * The pause case is the one worth the setup. It is the only place the three layers — SDK,
 * relay, console — have to agree, and D-27 exists because a high-frequency loop outliving the
 * stream it serves has already happened once in this repository.
 */

import { expect, test, type Page } from "@playwright/test";
import { goLive, panel } from "./support.js";

const SIGNAL = "ws://localhost:4182";

/** A live session with the shipped SDK streaming. */
async function liveSession(page: Page): Promise<string> {
  await goLive(page);
  await page.waitForTimeout(400);
  const id = await page.evaluate(() => {
    const events = (window as unknown as { __events: { name: string; detail?: { session?: string } }[] })
      .__events;
    return events.find((e) => e.name === "invited")?.detail?.session ?? null;
  });
  expect(id, "the page never reported an invited session").not.toBeNull();
  return id!;
}

/**
 * Hold an agent socket open for the length of a test, in the page's own context.
 *
 * Everything it receives is recorded on `window.__agent` so a test can move the real mouse
 * between sends — which is the whole point, since the customer's cursor only exists as a
 * consequence of a real pointer event.
 */
async function openAgent(page: Page, session: string): Promise<void> {
  await page.evaluate(
    async ([signal, sessionId]) => {
      const state = { frames: [] as Record<string, unknown>[], socket: null as WebSocket | null };
      (window as unknown as { __agent: typeof state }).__agent = state;

      const socket = new WebSocket(signal);
      state.socket = socket;
      await new Promise((r) => {
        socket.onopen = () => r(null);
      });
      socket.send(
        JSON.stringify({ type: "hello", role: "agent", session: sessionId, token: "tok_harness" })
      );
      socket.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (m.type === "presence.cursor") state.frames.push(m);
      };
    },
    [SIGNAL, session] as const
  );
  // The relay announces presence on attach, and the SDK re-snapshots when the agent count
  // rises. Let that settle so it cannot be mistaken for a cursor frame.
  await page.waitForTimeout(300);
}

async function agentFrames(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    () => (window as unknown as { __agent: { frames: Record<string, unknown>[] } }).__agent.frames
  );
}

async function clearAgent(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __agent: { frames: unknown[] } }).__agent.frames.length = 0;
  });
}

/** Send a cursor down the agent's socket, as the console does. */
async function agentPoints(page: Page, x: number | null, y: number | null): Promise<void> {
  await page.evaluate(
    ([cx, cy]) => {
      const { socket } = (window as unknown as { __agent: { socket: WebSocket } }).__agent;
      socket.send(JSON.stringify({ type: "presence.cursor", cursor: { x: cx, y: cy } }));
    },
    [x, y] as const
  );
  await page.waitForTimeout(250);
}

test("the customer's cursor reaches the agent", async ({ page }) => {
  const session = await liveSession(page);
  await openAgent(page, session);
  await clearAgent(page);

  // A real pointer move on the merchant's page, through the shipped bundle's own listener.
  await page.mouse.move(220, 260);
  await page.mouse.move(240, 280);
  await page.waitForTimeout(300);

  const frames = await agentFrames(page);
  expect(frames.length, "no cursor frame reached the agent").toBeGreaterThan(0);

  const positioned = frames.filter((f) => (f.cursor as { x: number | null }).x !== null);
  expect(positioned.length, "every frame said the customer was pointing at nothing").toBeGreaterThan(0);

  const last = positioned.at(-1)!;
  expect(last.role, "the relay must stamp which side sent this").toBe("subject");
  // The customer is the customer: the relay sends no name in this direction, and the console
  // labels them from its own strings.
  expect(last.who).toBeNull();
  expect(last.merchant).toBeNull();
});

test("the agent's cursor is drawn on the customer's page, named by the relay", async ({ page }) => {
  const session = await liveSession(page);
  await openAgent(page, session);

  await agentPoints(page, 0.4, 0.35);

  const overlay = page.locator("[data-sky-presence]").first();
  await expect(overlay, "the agent's cursor was never drawn").toHaveCount(1);
  await expect(overlay).toHaveCSS("opacity", "1");
  // The label is the relay's, not the sender's — the agent's socket sent only a coordinate.
  await expect(page.locator("[data-sky-presence] span")).toHaveText("Cyclo SAS · Amélie");
});

test("a view-only session still carries both cursors", async ({ page }) => {
  // D-23, end to end and in the demo's own shape. Presence must not require `control`: the
  // whole point is an agent who may look and not touch, pointing at the thing they are talking
  // about. The harness agent holds no control grant on this socket and the cursor still lands.
  const session = await liveSession(page);
  await openAgent(page, session);
  await clearAgent(page);

  await agentPoints(page, 0.6, 0.5);
  await expect(page.locator("[data-sky-presence]").first()).toHaveCSS("opacity", "1");

  await page.mouse.move(300, 300);
  await page.waitForTimeout(300);
  expect((await agentFrames(page)).length).toBeGreaterThan(0);
});

test("pausing the session stops presence in both directions", async ({ page }) => {
  // **The assertion this file exists for.** Three layers have to agree, and the failure mode is
  // a customer who pauses sharing, keeps browsing, and is still being watched — refuse-list
  // item 2 with the indicator telling the truth about the mirror and not about the cursor.
  //
  // The pause is a **capability narrowing**, not a teardown, and the distinction is the whole
  // test. `Sky.stop()` ends the session, which stops presence through `stopSession` — a
  // different code path that would pass this test whether or not `applyCapability` stopped
  // presence at all. What is exercised here is the case the customer actually reaches: the
  // session stays live, the socket stays open, and `current.surfaces` goes empty.
  const session = await liveSession(page);
  await openAgent(page, session);

  // The agent's cursor is on the page before the pause, so its removal is observable.
  await agentPoints(page, 0.4, 0.4);
  await expect(page.locator("[data-sky-presence]").first()).toHaveCSS("opacity", "1");

  // "Show them nothing" — the customer's own narrowing, over the consent frame's socket, which
  // is where their authority lives.
  await page.evaluate(async () => {
    const socket = new WebSocket("ws://localhost:4182");
    await new Promise((r) => {
      socket.onopen = () => r(null);
    });
    const session = (window as unknown as { __events: { name: string; detail?: { session?: string } }[] })
      .__events.find((e) => e.name === "invited")?.detail?.session;
    socket.send(JSON.stringify({ type: "hello", role: "subject", session, invite: "inv_harness" }));
    await new Promise((r) => setTimeout(r, 150));
    socket.send(
      JSON.stringify({ type: "capability.set", current: { access: "view", surfaces: [] } })
    );
  });
  await page.waitForTimeout(600);

  // The session is still live and the socket is still open — this is a pause, not a hangup.
  expect(await page.evaluate(() => (window as unknown as { Sky: { active: boolean } }).Sky.active))
    .toBe(true);

  await clearAgent(page);
  await page.mouse.move(360, 320);
  await page.mouse.move(380, 340);
  await page.waitForTimeout(400);

  expect(
    await agentFrames(page),
    "the customer's pointer was still being reported after they paused sharing"
  ).toEqual([]);

  // And nothing of ours is left standing on their page while it is paused.
  expect(
    await page.locator("[data-sky-presence]").count(),
    "the agent's cursor stayed on a page the customer had paused"
  ).toBe(0);
});
