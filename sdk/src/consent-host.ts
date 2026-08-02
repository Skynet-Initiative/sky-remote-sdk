/**
 * Hosting the consent surface, and watching that the page has not hidden it.
 *
 * This file **cannot reach inside** the frame it creates. Not by policy — by the
 * same-origin policy, which is what makes the boundary hold even if this bundle is fully
 * compromised (docs/03 §2a). What is here is the second layer: geometry.
 *
 * ## The cropping bug, and the shape that makes it unrepresentable
 *
 * Phase 2 created the iframe with `height: auto`. For a replaced element that means the
 * browser's default 150px, so the consent card was cropped and the Allow button sat below
 * the fold — unclickable consent, in front of a real customer. The patch was a
 * `postMessage` asking to be resized, which made the panel's usability depend on a
 * message arriving.
 *
 * Geometry is now the SDK's and comes from a **table of four fixed layouts**. The frame
 * names a state; it never names a size. Nothing here is derived from content, so there is
 * no content that can push a control out of view.
 *
 * ## The top layer
 *
 * The host is a `<dialog>`. In the `ask` state it is opened with `showModal()`, which puts
 * it in the browser's **top layer** — above every stacking context regardless of
 * `z-index`, unaffected by an ancestor's `transform`, `filter` or `opacity`, and with the
 * rest of the document made inert by the browser. That is a stronger answer to
 * clickjacking than any check we could write, because the page has nothing left to cover
 * it with. In the `indicator` states it is a manual popover, which is the same top layer
 * without the modality.
 *
 * The geometry watch below stays anyway. It is what covers the fallback path on a browser
 * without the top layer, and it is the check that survives this file being wrong.
 */

import type { ConsentSurfaceState, FrameToPage, PageToFrame } from "../../protocol/src/index.js";
import { important } from "./dom.js";

/** Every layout, in one table. Sizes are the SDK's; the frame only names a state. */
const LAYOUTS: Record<Exclude<ConsentSurfaceState, "gone">, (narrow: boolean) => Record<string, string>> = {
  // The whole viewport. A modal cannot be cropped because there is nothing left to crop
  // it against — this is the property the phase 2 layout did not have.
  ask: () => ({
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    "max-width": "none",
    "max-height": "none"
  }),
  indicator: (narrow) => indicatorLayout(narrow, narrow ? 108 : 96),
  "indicator-alert": (narrow) => indicatorLayout(narrow, narrow ? 148 : 132)
};

function indicatorLayout(narrow: boolean, height: number): Record<string, string> {
  if (narrow) {
    // A phone: a bottom sheet, full width inside the safe area. Pinned bottom-right at
    // 380px on a 360px screen would hang off the edge.
    return {
      position: "fixed",
      inset: "auto 8px calc(8px + env(safe-area-inset-bottom, 0px)) 8px",
      width: "auto",
      height: `${height}px`,
      "max-width": "none",
      "max-height": "none"
    };
  }
  return {
    position: "fixed",
    inset: `auto 16px 16px auto`,
    width: "min(400px, calc(100vw - 32px))",
    height: `${height}px`,
    "max-width": "none",
    "max-height": "none"
  };
}

/** Below this the indicator becomes a bottom sheet. */
const NARROW_PX = 560;

/** Below these the panel is refused as unusable, whatever put it there. */
const MIN_W = 200;
const MIN_H = 72;

/** Declarations that are not layout and must survive every state. */
const BASE_STYLE: Record<string, string> = {
  display: "block",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  overflow: "visible",
  "z-index": "2147483647",
  "color-scheme": "normal",
  "pointer-events": "auto"
};

export type GeometryProblem =
  | "detached"
  | "page-hidden"
  | "too-small"
  | "off-screen"
  | "hidden"
  | "faded"
  | "not-clickable"
  | "filtered"
  | "covered"
  /** The frame reloaded, so the panel that held the key and the stop control is gone. Not a
   *  geometry problem in the literal sense — the box is perfect — which is exactly why the
   *  geometry watch could not see it. */
  | "surface-lost";

export interface ConsentHostEvents {
  onMessage: (message: FrameToPage) => void;
  /** The frame has finished saying goodbye and asked to be removed. */
  onGone?: () => void;
  onGeometry: (ok: boolean, reason: GeometryProblem | null) => void;
}

export class ConsentHost {
  private host: HTMLDialogElement | null = null;
  private frame: HTMLIFrameElement | null = null;
  private styles: HTMLStyleElement | null = null;
  private listener: ((e: MessageEvent) => void) | null = null;
  private resizeListener: (() => void) | null = null;
  private visibilityListener: (() => void) | null = null;
  private watch: number | null = null;
  private state: ConsentSurfaceState = "ask";
  private lastOk = true;
  /** Has the frame loaded once? A second load means it was destroyed and re-created. */
  private loaded = false;
  /** The frame reloaded. Terminal: nothing brings that document back. */
  private lost = false;
  private readonly origin: string;

  constructor(
    private readonly consentUrl: string,
    private readonly events: ConsentHostEvents
  ) {
    this.origin = originOf(consentUrl);
  }

  get element(): HTMLIFrameElement | null {
    return this.frame;
  }

  get geometryOk(): boolean {
    return this.lastOk;
  }

  open(session: string, invite: string, signal: string, version: string, locale: string | null): void {
    this.styles = document.createElement("style");
    this.styles.setAttribute("data-sky-consent-style", "");
    // The scrim behind the modal, and it is scoped to the `ask` state **by attribute**.
    //
    // `::backdrop` is not the modal's alone: an element in the top layer renders it, and a
    // popover is in the top layer too. The rule here had no state in its selector, so the
    // dark scrim and its `blur(2px)` survived the switch to the `indicator` popover and sat
    // over the whole viewport for the length of the session — the customer's own page,
    // blurred, behind a 400×96 badge. It also painted the card's rounded corners dark, which
    // reads as a square box behind a rounded card.
    //
    // Scoped on `data-sky-surface` rather than on `:modal` deliberately: the state is
    // something this file already owns and sets, so the rule cannot disagree with the
    // promotion below, and it still holds on the fallback path where neither `showModal` nor
    // `showPopover` exists. The second rule is not redundant — it neutralises the UA's own
    // `::backdrop` for every non-ask state.
    this.styles.textContent =
      'dialog[data-sky-consent][data-sky-surface="ask"]::backdrop{' +
      "background:rgba(15,20,25,.45);backdrop-filter:blur(2px)}" +
      'dialog[data-sky-consent]:not([data-sky-surface="ask"])::backdrop{' +
      "background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none}" +
      "dialog[data-sky-consent]{border:0;padding:0;margin:0;background:transparent;max-width:none;max-height:none}";
    document.head.appendChild(this.styles);

    const host = document.createElement("dialog");
    host.setAttribute("data-sky-consent", "");
    // Never mirrored, and never a target for agent input. The serializer skips anything
    // carrying this attribute and the chokepoint excludes its rectangle by geometry.
    host.setAttribute("aria-label", "Remote assistance");
    this.host = host;

    const frame = document.createElement("iframe");
    frame.setAttribute("data-sky-consent", "");
    frame.setAttribute("title", "Remote assistance consent");
    // `allow-scripts` and `allow-same-origin` only: no forms, no popups, no top
    // navigation, no downloads. It needs to run its own code on its own origin, nothing
    // more.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("allow", "");
    frame.src = this.consentUrl;
    important(frame, {
      display: "block",
      width: "100%",
      height: "100%",
      border: "0",
      background: "transparent",
      "color-scheme": "normal"
    });
    // A modal `<dialog>` closes itself on Escape, and a consent panel that vanishes on a
    // keypress is worse than one that never appeared: the customer believes they have
    // dismissed it while the session sits waiting. Escape is handled *inside* the frame,
    // where it means "not now" and revokes.
    host.addEventListener("cancel", (e) => e.preventDefault());
    this.frame = frame;
    host.appendChild(frame);
    // On `documentElement` rather than `body`: a `transform` or `filter` on `<body>`
    // creates a containing block for fixed positioning, and on the fallback path that
    // would move the panel with the page.
    document.documentElement.appendChild(host);

    this.applyState("ask");

    this.listener = (e: MessageEvent) => {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      if (e.origin !== this.origin) return;
      const message = (e.data || {}) as FrameToPage;
      if (message.type === "sky.state") {
        this.applyState(message.state);
        return;
      }
      this.events.onMessage(message);
    };
    window.addEventListener("message", this.listener);

    this.resizeListener = () => this.applyState(this.state);
    window.addEventListener("resize", this.resizeListener);
    window.addEventListener("orientationchange", this.resizeListener);

    // The frame asks who is embedding it; we answer with the session and the invite, and
    // the browser tells it our origin. It does not take our word for the origin —
    // `event.origin` on this message is set by the browser and a page cannot forge it.
    //
    // **A second `load` is not a second start; it is the panel having been destroyed.**
    // Moving a `<dialog>` in the DOM re-creates the iframe inside it — the browser reloads the
    // document, which discards the session's non-extractable private key, its socket and its
    // consent state. Measured on a page that reparents the host into another element: the
    // popover leaves the top layer, the frame reloads, and `contentDocument` becomes
    // permanently unreachable. What is left is a rectangle with no stop control and no
    // indicator, while the SDK still reports `active`.
    //
    // The geometry watch cannot see this. It measures the `<dialog>`, and the dialog is fine —
    // right size, on top of the hit-test stack, fully opaque. Every check passes while the one
    // thing the surface exists for is gone. That is the shape worth naming: **an integrity
    // check on the container is not an integrity check on the contents.**
    //
    // Treated as the loss it is. Streaming stops through the same `onGeometry` path an
    // occlusion takes, so the customer's page is not being mirrored to an agent the customer
    // can no longer interrupt.
    frame.addEventListener("load", () => {
      if (this.loaded) {
        this.lost = true;
        this.lastOk = false;
        // Nothing recovers from here, so stop polling: `check()` returns on its first line for
        // the rest of the document's life, and the interval would keep waking the page anyway.
        //
        // **Cleared directly, not through `stopWatch()`.** That helper also resets
        // `lastOk = true`, which is right when a session ends and wrong here — `shouldStream`
        // reads it, so tidying up through the helper would let the page resume streaming to a
        // surface whose stop control no longer exists.
        if (this.watch !== null) window.clearInterval(this.watch);
        this.watch = null;
        this.events.onGeometry(false, "surface-lost");
        return;
      }
      this.loaded = true;
      this.post({ type: "sky.init", session, invite, signal, version, locale });
    });

    this.startWatch();
  }

  post(message: PageToFrame): void {
    this.frame?.contentWindow?.postMessage(message, this.origin);
  }

  close(): void {
    this.stopWatch();
    if (this.listener) {
      window.removeEventListener("message", this.listener);
      this.listener = null;
    }
    if (this.resizeListener) {
      window.removeEventListener("resize", this.resizeListener);
      window.removeEventListener("orientationchange", this.resizeListener);
      this.resizeListener = null;
    }
    this.host?.remove();
    this.styles?.remove();
    this.host = null;
    this.frame = null;
    this.styles = null;
  }

  // -- geometry ------------------------------------------------------------

  private applyState(state: ConsentSurfaceState): void {
    this.state = state;
    const host = this.host;
    if (!host) return;
    if (state === "gone") {
      this.close();
      this.events.onGone?.();
      return;
    }
    const narrow = window.innerWidth < NARROW_PX;
    // What the `::backdrop` rule keys on. Set before the layout so there is no frame in which
    // an indicator-sized popover is still carrying the ask's full-viewport scrim.
    host.setAttribute("data-sky-surface", state);
    important(host, { ...BASE_STYLE, ...LAYOUTS[state](narrow) });
    this.promote(state === "ask");
  }

  /**
   * Into the top layer, modal or not.
   *
   * `showModal` throws if the dialog is already open, and switching between the modal and
   * popover forms has to go through the closed state — but the element is never removed
   * from the document, so the iframe inside it is never re-created and the consent frame
   * keeps its key and its socket.
   */
  private promote(modal: boolean): void {
    const host = this.host;
    if (!host) return;
    const supported = typeof host.showModal === "function" && "showPopover" in host;
    if (!supported) {
      // No top layer. The fixed positioning and the maximum z-index above are the whole
      // defence, and the geometry watch is what notices when they are not enough.
      host.setAttribute("open", "");
      return;
    }
    try {
      if (modal) {
        if (host.matches(":popover-open")) host.hidePopover();
        if (!host.open) host.showModal();
      } else {
        if (host.open) host.close();
        host.setAttribute("popover", "manual");
        if (!host.matches(":popover-open")) host.showPopover();
      }
    } catch {
      host.setAttribute("open", "");
    }
  }

  /**
   * Is the customer's consent and stop control actually on screen and actually clickable?
   *
   * What this layer catches that the frame's own check cannot: the page covering it with
   * another element, or fading it with `opacity`, or scaling it away — all of which are
   * the PARENT's DOM and therefore invisible from inside a cross-origin frame.
   *
   * What the frame's own check catches that this cannot: this code being compromised.
   * Neither layer subsumes the other, which is why there are two.
   */
  problem(): GeometryProblem | null {
    const host = this.host;
    if (!host || !host.isConnected) return "detached";
    if (document.visibilityState === "hidden") return "page-hidden";

    const rect = host.getBoundingClientRect();
    if (rect.width < MIN_W || rect.height < MIN_H) return "too-small";
    if (rect.bottom < 0 || rect.top > window.innerHeight) return "off-screen";
    if (rect.right < 0 || rect.left > window.innerWidth) return "off-screen";

    for (let n: Element | null = host; n && n.nodeType === 1; n = n.parentElement) {
      const s = window.getComputedStyle(n);
      if (s.display === "none" || s.visibility !== "visible") return "hidden";
      if (parseFloat(s.opacity) < 0.95) return "faded";
      if (s.pointerEvents === "none") return "not-clickable";
      if (s.filter !== "none" && s.filter !== "") return "filtered";
    }

    // Five points, because a single centre test misses an overlay that covers only the
    // Stop button. `elementsFromPoint` returns the hit-test stack and the panel has to be
    // at the top of it.
    const points: [number, number][] = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + 8, rect.top + 8],
      [rect.right - 8, rect.top + 8],
      [rect.left + 8, rect.bottom - 8],
      [rect.right - 8, rect.bottom - 8]
    ];
    for (const [x, y] of points) {
      // `elementFromPoint` is defined as `elementsFromPoint(...)[0]` with identical hit-test
      // rules, and returns null in exactly the case that array is empty — without materialising
      // the 20-40 elements underneath, five times per poll for the session's whole life.
      const top = document.elementFromPoint(x, y);
      if (!top) return "covered";
      if (top !== host && !host.contains(top)) return "covered";
    }
    return null;
  }

  /**
   * One reading, reported only when the answer changed.
   *
   * Called by the poll below and, for the one problem the browser will tell us about, by the
   * event that announces it.
   */
  private check(): void {
    // `surface-lost` is terminal and the poll must not talk it back. The dialog it measures is
    // in perfect condition — right size, on top, opaque — so the very next tick would find no
    // problem, report `ok: true`, and resume streaming to a panel with no stop control in it.
    // The first version did exactly that: `obscured:surface-lost` immediately followed by
    // `visible`, which is worse than never having noticed, because it tells the integrator the
    // surface recovered.
    //
    // Nothing recovers a reloaded frame. The document that held the key is gone and the session
    // has to end or be re-presented.
    if (this.lost) return;
    const problem = this.problem();
    const ok = problem === null;
    if (ok === this.lastOk) return;
    this.lastOk = ok;
    this.events.onGeometry(ok, problem);
    this.post({ type: "sky.geometry", ok, reason: problem });
  }

  private startWatch(): void {
    this.stopWatch();
    this.watch = window.setInterval(() => this.check(), 500);
    // `page-hidden` is the one geometry problem with an event, and waiting for the next tick to
    // notice it meant up to half a second of a backgrounded tab still streaming. "Nothing
    // streams while the customer is not looking at the page" is a trust property (docs/03
    // refuse-list item 2), so it should not be enforced at polling resolution when the browser
    // will say so synchronously. The poll still covers every other problem and still covers
    // this one on a browser that does not fire the event.
    this.visibilityListener = () => this.check();
    document.addEventListener("visibilitychange", this.visibilityListener);
  }

  private stopWatch(): void {
    if (this.watch !== null) window.clearInterval(this.watch);
    this.watch = null;
    if (this.visibilityListener) {
      document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = null;
    }
    this.lastOk = true;
  }
}

export function originOf(url: string): string {
  const a = document.createElement("a");
  a.href = url;
  return a.protocol + "//" + a.host;
}
