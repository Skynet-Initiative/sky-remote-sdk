/**
 * The mirror refuses to render where a stranger's page could execute.
 *
 * `Mirror` is handed a `Document`; it does not create the frame. So the first of the three
 * rules in its own header — "an iframe with `sandbox=allow-same-origin` and NOT
 * `allow-scripts`" — is the *caller's* to keep, and the caller is the agent console, a
 * different application in a different repository. It was written in the same list as the two
 * rules this package does enforce, which reads as a guarantee it makes.
 *
 * `assertSandboxed` is what turns it into a checkable one. This suite pins both directions,
 * because a guard that never fires and a guard that always fires are both useless and only the
 * second is noticed.
 *
 * Worth recording what the probe had to become. `new view.Function("return 1")` only
 * constructs, and a sandbox blocks execution rather than construction; calling the result does
 * not distinguish either, because a same-origin parent may always call into its child. Measured
 * across all three frame kinds, it returned `1` every time. Only injecting a `<script>` and
 * asking whether it ran separates them — which is also the actual threat being guarded.
 */

import { expect, test } from "@playwright/test";
import { loadProbe } from "./support.js";

/** Build a mirror into a frame with the given sandbox, and report what happened. */
async function renderInto(
  page: import("@playwright/test").Page,
  sandbox: string | null
): Promise<{ threw: boolean; message: string }> {
  return page.evaluate((sb) => {
    const frame = document.createElement("iframe");
    if (sb !== null) frame.setAttribute("sandbox", sb);
    document.body.appendChild(frame);
    const snapshot = window.__sky.snapshot();
    try {
      window.__sky.rebuild(frame, snapshot);
      return { threw: false, message: "" };
    } catch (e) {
      return { threw: true, message: String((e as Error).message) };
    }
  }, sandbox);
}

test("a correctly sandboxed frame renders", async ({ page }) => {
  await loadProbe(page, "90-merchant.html");
  const out = await renderInto(page, "allow-same-origin");
  // The negative direction, and the one that would break every console if the probe were
  // wrong — as it was, twice, before it tested the right capability.
  expect(out.threw, `a sandboxed frame was refused: ${out.message}`).toBe(false);
});

test("a frame that can run scripts is refused", async ({ page }) => {
  await loadProbe(page, "90-merchant.html");
  const out = await renderInto(page, "allow-same-origin allow-scripts");
  expect(out.threw, "the mirror rendered into a document that can execute scripts").toBe(true);
  // The message has to name the fix. Whoever hits this is holding an `<iframe>` in another
  // repository and needs the attribute, not a description of the symptom.
  expect(out.message).toContain("allow-same-origin");
  expect(out.message).toContain("allow-scripts");
});

test("a frame with no sandbox at all is refused", async ({ page }) => {
  await loadProbe(page, "90-merchant.html");
  const out = await renderInto(page, null);
  // The likeliest real regression: someone builds the frame without the attribute rather than
  // with the wrong one.
  expect(out.threw, "the mirror rendered into an unsandboxed document").toBe(true);
});
