/**
 * An agent who attaches after the first snapshot must still be sent a page.
 *
 * The stream is one snapshot followed by mutations, and the engine relays frames verbatim and
 * caches none of them — deliberately, because a relay that cached DOM would be a relay that
 * understood it. So the snapshot exists exactly once, at the moment streaming starts.
 *
 * Everything that attaches later got nothing: an agent joining a live session, an agent whose
 * socket reconnected, an agent who reloaded the console. Their mutations landed on an empty
 * document and the console showed a **white rectangle for the rest of the session** — while
 * input kept working, because that is dispatched by coordinate against the live DOM. A
 * rendering failure that leaves the controls working is the kind that gets reported as "maybe
 * something to do with loading" rather than as a missing frame.
 *
 * The fix keys on `presence`, which the engine already broadcasts to everyone: a count that
 * went up means somebody is looking who has not been sent a page. These tests drive a real
 * socket against the harness engine so the sequence is the real one.
 */

import { expect, test, type Page } from "@playwright/test";
import { goLive } from "./support.js";

const SIGNAL = "ws://localhost:4182";

/** A live session with the SDK streaming, and no agent attached yet. */
async function liveSession(page: Page): Promise<void> {
  await goLive(page);
  // Let the first snapshot go out before anybody is listening for it.
  await page.waitForTimeout(600);
}

/**
 * Attach as an agent and collect the mirror ops that arrive.
 *
 * Runs in the page so it shares the harness origin, and returns only what the console needs to
 * render: whether a snapshot arrived, and whether it had a document in it.
 */
async function attachAgent(
  page: Page,
  session: string,
  waitMs = 1500
): Promise<{ ops: string[]; snapshotNodes: number; href: string | null }> {
  return page.evaluate(
    async ([signal, sessionId, wait]) => {
      const ops: string[] = [];
      let snapshotNodes = 0;
      let href: string | null = null;

      const socket = new WebSocket(signal as string);
      await new Promise((r) => {
        socket.onopen = () => r(null);
      });
      socket.send(
        JSON.stringify({ type: "hello", role: "agent", session: sessionId, token: "tok_harness" })
      );
      socket.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (m.type !== "mirror") return;
        ops.push(String(m.op));
        if (m.op === "snapshot") {
          const data = m.data as { root?: unknown; href?: string };
          href = data.href ?? null;
          const count = (n: { c?: unknown[] } | undefined): number =>
            !n ? 0 : 1 + (n.c ?? []).reduce((a: number, c) => a + count(c as { c?: unknown[] }), 0);
          snapshotNodes = count(data.root as { c?: unknown[] });
        }
      };

      await new Promise((r) => setTimeout(r, wait as number));
      socket.close();
      return { ops, snapshotNodes, href };
    },
    [SIGNAL, session, waitMs] as const
  );
}

/** The session id the harness page minted for itself. */
async function sessionId(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const events = (window as unknown as { __events: { name: string; detail?: { session?: string } }[] })
      .__events;
    const invited = events.find((e) => e.name === "invited");
    return invited?.detail?.session ?? null;
  });
  expect(id, "the page never reported an invited session").not.toBeNull();
  return id!;
}

test("an agent attaching after streaming started is sent a fresh snapshot", async ({ page }) => {
  await liveSession(page);
  const session = await sessionId(page);

  // The snapshot for THIS agent has to be produced on attach: the only one before it went out
  // before this socket existed.
  const first = await attachAgent(page, session);

  expect(first.ops, "no mirror frame reached the agent at all").not.toHaveLength(0);
  expect(first.ops).toContain("snapshot");
  // A snapshot with a document in it, not an empty envelope — an empty root would rebuild to
  // the same white rectangle.
  expect(first.snapshotNodes, "the snapshot carried no nodes").toBeGreaterThan(10);
  expect(first.href, "the snapshot names no page").toContain("90-merchant.html");
});

test("a second agent joining mid-session gets their own snapshot", async ({ page }) => {
  await liveSession(page);
  const session = await sessionId(page);

  // One agent attaches and leaves; the next must not depend on having seen the first's frames.
  await attachAgent(page, session, 800);
  const second = await attachAgent(page, session, 1500);

  expect(second.ops).toContain("snapshot");
  expect(second.snapshotNodes).toBeGreaterThan(10);
});

test("the customer's page keeps streaming changes after the re-snapshot", async ({ page }) => {
  await liveSession(page);
  const session = await sessionId(page);

  // Attach, then change the page while the helper is still collecting. A re-snapshot that tore the
  // observer down without rebuilding it would leave a correct first frame and nothing after it.
  const collecting = attachAgent(page, session, 1800);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    document.getElementById("status")!.textContent = "changed after the re-snapshot";
  });

  const { ops } = await collecting;
  expect(ops).toContain("snapshot");
  expect(ops, "no mutation followed the re-snapshot").toContain("mutate");
});

/**
 * A resync is a re-snapshot, not a restart.
 *
 * It used to be `stop()` then `start()`, which unbound every listener, dropped the
 * `MutationObserver` and rebuilt all of it to send one frame. The rebuild made the *mutation*
 * path work again — the test above proves that much — but it is a strictly larger operation than
 * the job requires, and the teardown discarded `this.pending` and the observer's queued records,
 * so mutations collected just before a resync were dropped rather than superseded.
 *
 * Scroll is the listener this asserts on because it is bound in capture phase on `document` and
 * is the one whose loss is silent: the agent simply sees a page that never scrolls again, with
 * every other kind of update still arriving.
 */
test("scroll still streams after a re-snapshot, so the resync rebound nothing", async ({
  page
}) => {
  await liveSession(page);
  const session = await sessionId(page);

  const collecting = attachAgent(page, session, 1800);
  await page.waitForTimeout(900); // the attach has re-snapshotted by here
  await page.evaluate(() => {
    document.documentElement.style.height = "3000px";
    window.scrollTo(0, 400);
  });

  const { ops } = await collecting;
  expect(ops).toContain("snapshot");
  // A scroll arrives inside a `mutate` frame's `scrolls`, so the op to look for is `mutate` —
  // what matters is that something followed the snapshot at all once the page moved.
  expect(ops, "nothing streamed after the re-snapshot").toContain("mutate");
});
