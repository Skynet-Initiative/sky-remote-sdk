/**
 * Presence: where each participant is pointing.
 *
 * Two halves, both on the customer's page, and they are asymmetric on purpose.
 *
 * **Outbound** — the customer's own pointer, normalised and throttled, suppressed while it is
 * inside a region the serializer marked opaque. That suppression is the half that is not
 * obvious and it is the one that matters: a coordinate inside a masked field is a partial read
 * of a region we promised not to transmit (D-26). Caret
 * position implies value length; dwell implies a credential is being entered right now.
 *
 * **Inbound** — the agent's cursor, drawn into an element this file owns.
 *
 * ## Why this is not input, mechanically rather than as a claim
 *
 * The agent's cursor is a `<div>` with a `transform`. There is no `dispatchEvent` in this file,
 * no `elementFromPoint` resolution to a page node, and nothing here consults the input
 * chokepoint because nothing here reaches the page's own event handlers. That is what lets
 * presence be available at `view` while input requires `control`
 * (D-23) — a view-only agent can point at the button instead
 * of describing it, without an escalation to control that pointing would otherwise force.
 *
 * ## Our UI on someone else's page
 *
 * The same problem the consent surface has, and the same answers, because the page is only
 * semi-trusted and its CSS can do anything to an element it can select:
 *
 *  - every declaration is `!important`, so a merchant's `div { position: static }` cannot
 *    strand the cursor;
 *  - it carries `data-sky-presence`, which the serializer skips, so our own overlay is never
 *    mirrored back to the agent as part of the customer's page;
 *  - `pointer-events: none`, so it can never intercept a click the customer meant for the page
 *    underneath — a cursor that swallowed input would be the clickjacking risk the consent
 *    surface's geometry watch exists to prevent, introduced by the thing drawing the cursor;
 *  - it is removed when the session is not streaming, not merely hidden, so nothing of ours
 *    outlives the stream (D-27).
 *
 * It is deliberately *not* in the consent surface's cross-origin frame. That frame is sized
 * from a closed table of two layouts and must stay that way — a full-viewport overlay is
 * exactly what it refuses to be, and putting the cursor in it would mean the one element whose
 * geometry is guaranteed could suddenly cover the page.
 */

import { PRESENCE_IDLE_MS, PRESENCE_THROTTLE_MS, type PresenceCursor } from "../../protocol/src/index.js";
import { important } from "./dom.js";
import type { Serializer } from "./serializer.js";

/** Marks every node this module creates. The serializer skips anything carrying it. */
export const PRESENCE_ATTRIBUTE = "data-sky-presence";

export interface PresenceHost {
  serializer: Serializer;
  /** Where a cursor frame goes. Never called while the session is not streaming. */
  send: (cursor: PresenceCursor) => void;
}

/**
 * A label drawn beside the agent's cursor, or nothing.
 *
 * Both strings are engine-authored. `who` is `null` when no display name was ever pushed for
 * that agent, and the renderer shows **no label** rather than falling back to an identifier —
 * an `act_7f21…` on a customer's own page is noise that looks like a defect.
 */
export interface PresenceLabel {
  merchant: string | null;
  who: string | null;
}

/**
 * What the label reads, given what the engine supplied.
 *
 * The merchant's name leads and the agent's name qualifies it, never the reverse and never the
 * agent's name alone. Contract §7's surviving insight after D-25
 * reversed its rule: a stranger's name means nothing to a customer standing on its own, and
 * means something beside a name they recognise.
 */
export function labelText({ merchant, who }: PresenceLabel): string {
  const m = merchant?.trim();
  const w = who?.trim();
  if (m && w) return `${m} · ${w}`;
  if (m) return m;
  // No merchant name is a misconfigured workspace rather than a normal state, and an agent's
  // bare name would be the one rendering §7 warns about. Say what is true instead.
  return w ? `${w} (support)` : "Support";
}

export class Presence {
  private overlay: HTMLDivElement | null = null;
  /** Only the label is held after construction: it is the one node whose content changes. The
   *  arrow is written once and moves with the overlay it is inside. */
  private label: HTMLSpanElement | null = null;
  private moveListener: ((e: PointerEvent) => void) | null = null;
  private leaveListener: (() => void) | null = null;
  private throttle: number | null = null;
  private idle: number | null = null;
  /** The most recent position not yet sent, or null for "the pointer is not reportable". */
  /** The last sample seen, still un-classified. See `queue`. */
  private queued: { x: number; y: number; target: Element | null } | null = null;
  /** A pending "not pointing", which needs no target and cannot be superseded by a position. */
  private queuedAway = false;
  private lastSent: PresenceCursor | null = null;
  private running = false;

  constructor(private readonly host: PresenceHost) {}

  get active(): boolean {
    return this.running;
  }

  /** Begin reporting this page's pointer, and accept the agent's. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.moveListener = (e: PointerEvent) => this.onPointer(e);
    this.leaveListener = () => this.away();
    // Capture, so a page that stops propagation on its own handlers does not silently stop
    // the customer's cursor reaching the agent. Passive: this listener never calls
    // `preventDefault` and must never delay a scroll on the customer's own page.
    window.addEventListener("pointermove", this.moveListener, { capture: true, passive: true });
    window.addEventListener("pointerleave", this.leaveListener, { capture: true, passive: true });
    // A backgrounded tab stops firing pointer events without saying so, which would leave the
    // last position standing on the agent's screen as though it were current.
    document.addEventListener("visibilitychange", this.leaveListener);
  }

  /**
   * Stop everything, in both directions.
   *
   * D-27. Called from `applyCapability` beside `stream.stop()`
   * — the same decision that stops the mirror, not a second one that has to agree with it. The
   * overlay is **removed** rather than hidden: a paused session must leave nothing of ours on
   * the page, and a hidden element is one CSS rule away from being visible again.
   */
  stop(): void {
    this.running = false;
    if (this.moveListener) {
      window.removeEventListener("pointermove", this.moveListener, { capture: true });
      this.moveListener = null;
    }
    if (this.leaveListener) {
      window.removeEventListener("pointerleave", this.leaveListener, { capture: true });
      document.removeEventListener("visibilitychange", this.leaveListener);
      this.leaveListener = null;
    }
    if (this.throttle !== null) window.clearTimeout(this.throttle);
    this.throttle = null;
    if (this.idle !== null) window.clearTimeout(this.idle);
    this.idle = null;
    this.queued = null;
    this.queuedAway = false;
    this.lastSent = null;
    this.removeOverlay();
  }

  // -- outbound: the customer's pointer -------------------------------------

  /**
   * One pointer move, classified.
   *
   * The suppression check is the same opaque-marker walk the input chokepoint runs, pointed at
   * the customer's own pointer instead of at the agent's coordinate. One predicate, reused, at
   * the only place that knows the answer — the engine has no DOM and must not acquire one.
   */
  private onPointer(e: PointerEvent): void {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const x = e.clientX / w;
    const y = e.clientY / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      this.away();
      return;
    }
    // Classification is deferred to the throttle: `suppressed` walks ancestors, and running it
    // per pointer event meant doing so about six times per frame that is ever sent — every
    // sample but the last is discarded 50ms later. Evaluating it at send time also matches what
    // the input chokepoint does deliberately (`input.ts`): the coordinate is resolved against
    // the **live** DOM, so a region that became opaque in the meantime is refused too.
    this.queue(x, y, e.target as Element | null);
  }

  /**
   * Is this element inside something the serializer could not represent?
   *
   * **`Serializer.representability`, the same function the input chokepoint calls** — pointed
   * at the customer's own pointer instead of at the agent's coordinate. D-26 describes this as
   * one predicate reused, and until it was made public on `Serializer` it was two copies with
   * that sentence written above each of them.
   *
   * Fails closed: a node the serializer never emitted was never shown to the agent either, so a
   * position over it is not reportable. The composed path is used rather than `event.target`
   * alone because a pointer over a shadow-root child reports the host, and it is the host that
   * carries the marker.
   */
  private suppressed(target: EventTarget | null): boolean {
    const node = target as Element | null;
    if (!node || node.nodeType !== 1) return true;
    return this.host.serializer.representability(node) !== null;
  }

  /**
   * Hold the newest position and send at most one per `PRESENCE_THROTTLE_MS`.
   *
   * Trailing rather than leading: what matters is where the pointer *is* when the timer fires,
   * not where it was when the burst began. A leading throttle on a 20 Hz stream of moves sends
   * the first sample of each window and discards the rest, so a fast gesture arrives as its
   * starting points rather than its path.
   */
  /** Stop reporting a position: off the viewport, pointer gone, or session over. */
  private away(): void {
    if (!this.running) return;
    this.queued = null;
    this.queuedAway = true;
    this.schedule();
  }

  private queue(x: number, y: number, target: Element | null): void {
    if (!this.running) return;
    this.queued = { x, y, target };
    this.queuedAway = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.throttle !== null) return;
    this.throttle = window.setTimeout(() => {
      this.throttle = null;
      const sample = this.queued;
      const away = this.queuedAway;
      this.queued = null;
      this.queuedAway = false;
      if (!this.running) return;
      if (!away && !sample) return;
      // D-26: inside a region we do not report, the position is dropped rather than clamped or
      // rounded. The agent sees the cursor disappear, which is the honest rendering — the
      // customer is somewhere we said we would not report.
      const reportable = !away && sample !== null && !this.suppressed(sample.target);
      const next: PresenceCursor = reportable
        ? { x: sample!.x, y: sample!.y }
        : { x: null, y: null };
      // A repeated "not pointing" is not worth a frame. A repeated *position* is: it is what
      // keeps the receiver's idle timer from hiding a cursor that is genuinely parked.
      if (next.x === null && this.lastSent?.x === null) return;
      this.lastSent = next;
      this.host.send(next);
    }, PRESENCE_THROTTLE_MS);
  }

  // -- inbound: the agent's cursor ------------------------------------------

  /** Draw the agent's cursor, or hide it when they are not pointing at anything. */
  show(cursor: PresenceCursor, label: PresenceLabel): void {
    // A frame that arrives after the stream stopped is dropped rather than drawn. The engine
    // already refuses to relay one, so this is the second layer rather than the only one.
    if (!this.running) return;
    if (cursor.x === null || cursor.y === null) {
      this.hide();
      return;
    }
    const overlay = this.ensureOverlay();
    const text = labelText(label);
    if (this.label && this.label.textContent !== text) this.label.textContent = text;
    overlay.style.setProperty("opacity", "1", "important");
    // Percentages rather than pixels, so a resize between frames moves the cursor with the
    // layout instead of stranding it: the coordinate is normalised to the viewport and the
    // element is positioned in the same space.
    overlay.style.setProperty("left", `${cursor.x * 100}%`, "important");
    overlay.style.setProperty("top", `${cursor.y * 100}%`, "important");

    // The receiver's backstop. A peer whose tab was backgrounded stops sending without saying
    // so, and a cursor left standing makes a claim about *now* that is no longer true.
    if (this.idle !== null) window.clearTimeout(this.idle);
    this.idle = window.setTimeout(() => this.hide(), PRESENCE_IDLE_MS);
  }

  private hide(): void {
    if (this.idle !== null) window.clearTimeout(this.idle);
    this.idle = null;
    this.overlay?.style.setProperty("opacity", "0", "important");
  }

  private ensureOverlay(): HTMLDivElement {
    if (this.overlay) return this.overlay;

    const overlay = document.createElement("div");
    overlay.setAttribute(PRESENCE_ATTRIBUTE, "");
    // Not announced. The customer is told an agent is watching by the consent surface, which
    // is the surface that cannot be suppressed; a live region firing on every pointer move
    // would flood a screen reader with a position its user cannot act on.
    overlay.setAttribute("aria-hidden", "true");
    important(overlay, {
      position: "fixed",
      left: "0",
      top: "0",
      // Above ordinary page content and deliberately below the consent surface, which is in
      // the browser's top layer and therefore above this regardless. That ordering is not
      // decorative: our cursor must never be drawn over the customer's stop control.
      "z-index": "2147483000",
      // The whole reason this can be an overlay at all. It cannot receive a click, so it
      // cannot intercept one the customer meant for the page underneath.
      "pointer-events": "none",
      // Linear over exactly the send interval. At 20 Hz an uninterpolated cursor visibly
      // steps; a linear transition makes it continuous without adding latency beyond the
      // interval. Easing would look smoother and lie about direction, which is the one thing
      // a pointer must not do.
      transition: `left ${PRESENCE_THROTTLE_MS}ms linear, top ${PRESENCE_THROTTLE_MS}ms linear, opacity 120ms linear`,
      opacity: "0",
      // Isolate from the page's own cascade as far as a single element can be.
      margin: "0",
      padding: "0",
      border: "0",
      "font-family": "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      "font-size": "12px",
      "line-height": "1",
      "font-weight": "600",
      "text-align": "left",
      direction: "ltr",
      "letter-spacing": "normal",
      "text-transform": "none",
      "color-scheme": "normal"
    });

    // The arrow. An inline SVG rather than a background image: no request, nothing to fail to
    // load, and it renders identically whatever the page has done to `img`.
    const dot = document.createElement("div");
    dot.setAttribute(PRESENCE_ATTRIBUTE, "");
    dot.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 2l11 7.5-5 .8-2.2 5.2z" fill="#2563eb" stroke="#fff" stroke-width="1.4" ' +
      'stroke-linejoin="round"/></svg>';
    important(dot, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "20px",
      height: "20px",
      // The point of the arrow is its top-left corner, which is where the coordinate is.
      transform: "none",
      "pointer-events": "none",
      filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))"
    });

    const label = document.createElement("span");
    label.setAttribute(PRESENCE_ATTRIBUTE, "");
    important(label, {
      position: "absolute",
      left: "17px",
      top: "18px",
      display: "block",
      "max-width": "220px",
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
      background: "#2563eb",
      color: "#fff",
      padding: "3px 7px",
      "border-radius": "10px",
      "box-shadow": "0 1px 3px rgba(0,0,0,.3)",
      "pointer-events": "none"
    });

    overlay.appendChild(dot);
    overlay.appendChild(label);
    // On `documentElement` rather than `body`, for the reason the consent host documents: a
    // `transform` or `filter` on `<body>` creates a containing block for fixed positioning and
    // would move the cursor with the page instead of with the viewport.
    document.documentElement.appendChild(overlay);

    this.overlay = overlay;
    this.label = label;
    return overlay;
  }

  private removeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.label = null;
  }
}
