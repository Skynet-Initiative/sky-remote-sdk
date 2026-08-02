/**
 * A test-only handle on the two ends of the mirror contract.
 *
 * The fidelity tests need to serialize a page and rebuild it **in the same browser**, so
 * that a difference between the two is a difference the contract introduced rather than a
 * difference between two rendering environments. Neither the shipped SDK bundle nor the
 * mirror package exposes these internals, and neither should: this file exists so the
 * harness does not become a reason to widen a public API.
 *
 * Never bundled into anything that ships. `build-probe.mjs` writes it into
 * `harness/.probe/`, which is git-ignored.
 */

import { applyOptions, initialConfig, type SkyOptions } from "../../sdk/src/config.js";
import { Chokepoint } from "../../sdk/src/input.js";
import { Presence } from "../../sdk/src/presence.js";
import { Serializer } from "../../sdk/src/serializer.js";
import { Mirror } from "../../mirror/src/index.js";
import type { MirrorSnapshot, PresenceCursor } from "../../protocol/src/index.js";

const config = initialConfig();
const serializer = new Serializer({ config });
const chokepoint = new Chokepoint({ serializer, consentFrame: () => null });

/**
 * Every presence frame the SDK would put on the wire, captured instead of sent.
 *
 * **At the wire and not at the render**, which is the whole point of this hook. The fidelity
 * suite compares rendered output, so a cursor coordinate that leaks out of a masked region
 * would be invisible to it — the mirror would look identical either way. What D-26 promises is
 * about the *bytes*, so the assertion has to be about the bytes.
 */
const sent: PresenceCursor[] = [];
const presence = new Presence({ serializer, send: (cursor) => sent.push(cursor) });

declare global {
  interface Window {
    __sky: {
      /** Read-only on purpose: configuration goes through `applyOptions`, which is the door an
       *  integrator uses and the one that runs `readTier` and `compileSelectors`. Assigning to
       *  the resolved config skipped both, so a tier test could pass against a value the real
       *  validation would have refused. */
      readonly config: Readonly<typeof config>;
      serializer: Serializer;
      snapshot: () => MirrorSnapshot;
      rebuild: (frame: HTMLIFrameElement, snapshot: MirrorSnapshot) => void;
      mirrorOf: (frame: HTMLIFrameElement) => Mirror;
      measure: (root: Document) => Record<string, Measurement>;
      dispatch: (x: number, y: number) => string | null;
      refuseKey: (code: string) => string | null;
      typeableInto: (selector: string) => string | null;
      /** The only way to configure the probe. Throws exactly as `configure()` does. */
      applyOptions: (options: SkyOptions) => void;

      /** Presence, at the wire. See `sent` above for why this is not a render assertion. */
      presence: {
        start: () => void;
        stop: () => void;
        active: () => boolean;
        /** What has been queued for the wire since `clear()`. */
        sent: () => PresenceCursor[];
        clear: () => void;
        /** Draw an inbound cursor, as the agent's would be. */
        show: (cursor: PresenceCursor, merchant: string | null, who: string | null) => void;
      };
    };
  }
}

export interface Measurement {
  rect: { x: number; y: number; w: number; h: number };
  style: Record<string, string>;
  text: string;
  /** The reason the mirror rendered this region inert, if it did. An inert region is
   *  striped on purpose, so comparing its colours against the original would be asserting
   *  that a deliberate difference is a bug. Its BOX still has to match. */
  opaque: string | null;
}

/** The properties a customer would notice. Enough that "the page looks the same" is a
 *  claim with a test behind it, few enough that the test does not fail on a sub-pixel. */
const WATCHED = [
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "display",
  "position",
  "border-top-width",
  "border-top-color",
  "border-radius",
  "padding-top",
  "padding-left",
  "margin-top",
  "grid-template-columns",
  "text-align",
  "opacity",
  "visibility"
];

const mirrors = new WeakMap<HTMLIFrameElement, Mirror>();

function measure(root: Document): Record<string, Measurement> {
  const out: Record<string, Measurement> = {};
  const view = root.defaultView ?? window;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-probe]"))) {
    const name = el.dataset.probe!;
    const rect = el.getBoundingClientRect();
    const computed = view.getComputedStyle(el);
    const style: Record<string, string> = {};
    for (const property of WATCHED) style[property] = computed.getPropertyValue(property);
    out[name] = {
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      style,
      text: (el.textContent ?? "").trim().slice(0, 120),
      opaque: el.getAttribute("data-sky-opaque")
    };
  }
  return out;
}

window.__sky = {
  config,
  serializer,
  snapshot: () => serializer.snapshot(),
  mirrorOf(frame) {
    let mirror = mirrors.get(frame);
    if (!mirror) {
      mirror = new Mirror(frame.contentDocument!);
      mirrors.set(frame, mirror);
    }
    return mirror;
  },
  rebuild(frame, snapshot) {
    window.__sky.mirrorOf(frame).applySnapshot(snapshot);
  },
  measure,
  dispatch: (x, y) => chokepoint.representability(x, y),
  refuseKey: (code) => chokepoint.dispatch({ kind: "key", code, action: "down" }),
  /**
   * Whether the chokepoint would accept a keystroke aimed at this element.
   *
   * Focuses it first, because a key event has no coordinate and the chokepoint resolves it
   * against `document.activeElement` — so this is the real path a keystroke takes, not a
   * reimplementation of the decision. Returns the refusal, or null if it would be delivered.
   *
   * Snapshots first, because the chokepoint fails closed on any node the serializer has not
   * seen: without a prior serialization every element is `"unknown"`, which is correct
   * behaviour and would make this helper answer a different question from the one asked. A
   * live session always has a snapshot before input is possible.
   */
  typeableInto(selector: string) {
    serializer.snapshot();
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return "no-such-element";
    el.focus();
    if (document.activeElement !== el) return "not-focusable";
    return chokepoint.dispatch({ kind: "key", code: "a", action: "down" });
  },
  applyOptions: (options) => {
    applyOptions(config, options);
  },
  presence: {
    start: () => {
      // The suppression walk fails closed on any node the serializer has not seen, so without
      // a snapshot every position would be dropped as `unknown` — correct behaviour, and it
      // would make every assertion here answer a different question. A live session always has
      // a snapshot before presence runs.
      serializer.snapshot();
      presence.start();
    },
    stop: () => presence.stop(),
    active: () => presence.active,
    sent: () => sent.slice(),
    clear: () => {
      sent.length = 0;
    },
    show: (cursor, merchant, who) => presence.show(cursor, { merchant, who })
  }
};

export {};
