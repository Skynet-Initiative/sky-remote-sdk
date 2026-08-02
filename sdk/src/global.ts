/**
 * The script-tag entry point.
 *
 * Reads `data-*` from its own `<script>` element, creates the singleton and publishes it
 * as `window.Sky`. The ESM entry (`index.ts`) exports `createSky` and publishes nothing,
 * because a module that assigns a global is a module that cannot be imported twice.
 *
 * Calls queued before the bundle loaded are replayed. A page that does
 * `window.Sky = window.Sky || []; Sky.push(["on", "queued", fn])` above an `async` script
 * tag then works the same as one that waits — which is the difference between a snippet
 * that can go in the `<head>` and one that has to go at the end of the `<body>`.
 */

import { createSky, type SkyApi } from "./index.js";
import { readScriptAttributes } from "./config.js";

type QueuedCall = [keyof SkyApi, ...unknown[]];

declare global {
  interface Window {
    Sky?: SkyApi | QueuedCall[];
  }
}

const queued = Array.isArray(window.Sky) ? window.Sky : [];
const sky = createSky(readScriptAttributes());
window.Sky = sky;

for (const call of queued) {
  if (!Array.isArray(call) || !call.length) continue;
  const [method, ...args] = call;
  const fn = (sky as unknown as Record<string, unknown>)[method as string];
  if (typeof fn === "function") {
    try {
      (fn as (...a: unknown[]) => unknown).apply(sky, args);
    } catch (e) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[sky-remote] queued call failed", method, e);
      }
    }
  }
}

export {};
