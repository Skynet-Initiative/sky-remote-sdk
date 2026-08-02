/**
 * The mirror stream: one snapshot, then everything that changes.
 *
 * Four sources, because `MutationObserver` sees only one of them:
 *
 *  - **Mutations** — nodes, attributes and character data. Coalesced to one animation
 *    frame, because a single React render can produce hundreds of records and a
 *    mutation-per-message stream is what makes a naive mirror unusable on a real page.
 *  - **Input** — a typed character changes a property, not an attribute.
 *  - **Scroll** — reported for the document *and* for scrollable elements. A chat panel
 *    or a virtualised list that mirrors at the top shows the agent a different page from
 *    the one the customer is reading.
 *  - **Stylesheet rules** — `insertRule` fires no mutation record at all, and neither does
 *    editing a rule in place, so a CSS-in-JS runtime or a theme switcher would silently stop
 *    being mirrored. A cheap signature per sheet is sampled instead of patching
 *    `CSSStyleSheet.prototype`, which would mean this file modifying globals on a page it does
 *    not own.
 */

import type { MirrorMutation, OutboundFrame } from "../../protocol/src/index.js";
import { maskText, Serializer, viewportOf } from "./serializer.js";
import { captureElementStyles, isStyleBearing } from "./styles.js";

/**
 * The socket write.
 *
 * Takes either the frame or an already-serialized frame. The snapshot path needs its own
 * length in bytes before sending, and computing that meant stringifying the whole thing —
 * so it hands the string over rather than making the transport do it a second time.
 */
type Send = (frame: OutboundFrame | { serialized: string }) => void;

/** How often each sheet's signature is compared. Computing one is three `cssText` reads;
 *  re-serializing a whole sheet is not, and only happens when the signature moved. */
const SHEET_POLL_MS = 1000;

/** Scroll fires at pointer rate. One frame's worth is what the console can render. */
const SCROLL_COALESCE_MS = 50;

/**
 * The engine's frame ceiling, restated here because this end has to predict it.
 *
 * It is `MAX_FRAME_BYTES` in `crates/engine/src/signal.rs` and it is enforced there — a peer
 * over the limit has its connection closed, and since the transport bounds the read there is
 * not even an error frame to receive. Duplicating the number is the lesser evil: the
 * alternative is the SDK discovering the limit by being disconnected, with nothing to tell the
 * integrator. `PROTOCOL.md` carries the value as the shared statement of it.
 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

interface Bound {
  target: EventTarget;
  event: string;
  fn: EventListener;
  capture: boolean;
}

export class MirrorStream {
  private observer: MutationObserver | null = null;
  private pending: MirrorMutation | null = null;
  private flushTimer: number | null = null;
  private sheetTimer: number | null = null;
  private scrollTimer: number | null = null;
  private readonly pendingScrolls = new Map<number, { id: number; x: number; y: number }>();
  private readonly sheetSizes = new WeakMap<Element, number>();
  private bound: Bound[] = [];
  private running = false;

  constructor(
    private readonly serializer: Serializer,
    private readonly send: Send,
    /** Told when a snapshot will not fit. Routed to the SDK's `degraded` event. */
    private readonly onOversize: (what: string) => void = () => {}
  ) {}

  get active(): boolean {
    return this.running;
  }

  /**
   * Send the whole page again.
   *
   * Two callers, two reasons, one operation: a new agent attached and has never been sent a page,
   * or the application navigated and most of the document was replaced at once.
   *
   * **No longer a teardown and rebuild**, which was both a cost and a correctness bug.
   *
   * The cost: `stop()` unbinds four listener sets, drops the `MutationObserver`, clears the
   * sheet-size baseline and kills three timers, and `start()` rebuilds all of it — to send one
   * frame. On a single-page app this runs on every route change, and the presence path runs it
   * per agent attaching.
   *
   * The bug is worse and is why this is not merely tidying. A snapshot is only correct if it is
   * a boundary: everything before it is IN it, everything after arrives as a mutation. The
   * teardown broke that at both ends. `this.pending = null` discarded a batch that had been
   * collected but not yet flushed, and `observer.disconnect()` discards records the browser has
   * queued but not yet delivered — so mutations from just before the resync were dropped,
   * silently, and the console kept whatever stale nodes they described. The new snapshot papered
   * over it in the common case, which is exactly what made it survivable and invisible: it only
   * shows when a mutation lands in that window and describes something the snapshot then reads
   * differently.
   *
   * Taking the observer's outstanding records and dropping the pending batch **before** the
   * snapshot is what makes the boundary true. Those records describe the DOM the snapshot is
   * about to serialize wholesale, so they are redundant rather than lost — which is the one
   * ordering in which discarding them is sound.
   */
  resync(): void {
    if (!this.running) return;
    // Everything the observer has queued describes the tree we are about to re-read in full.
    // Take them so they cannot be delivered *after* the snapshot as though they came later.
    this.observer?.takeRecords();
    this.discardPending();

    this.sendSnapshot();
    // The snapshot re-read every sheet, so the baseline has to be re-taken against it or the
    // next poll would diff against counts from before the navigation and re-send every sheet.
    this.rememberSheetSizes();
  }

  /**
   * The snapshot, with the one failure this end can see coming.
   *
   * The engine closes a connection carrying a frame over `MAX_FRAME_BYTES` (4 MiB) — and now
   * refuses it at the transport, so it does not even arrive as an error frame the SDK could
   * read. What the customer would experience is the session simply dying, on page load, with
   * nothing said; what an integrator would report is "it does not work on our product page".
   *
   * The serializer bounds its *parts* — 32 KB per inline image, 512 KB per stylesheet — and
   * nothing bounded the assembled whole. A DOM large enough to exceed 4 MiB of JSON is unusual
   * and entirely reachable: a long table, a virtualised list rendered eagerly, a page with many
   * large data URLs each under the per-image cap.
   *
   * This cannot fix the page, so it does not pretend to. It reports through `degraded`, which
   * is the channel that already exists for "fidelity was reduced for a reason worth telling the
   * integrator about", and sends anyway — the engine's answer is authoritative and a snapshot
   * that is merely close to the limit must still go. The value is that the failure has a name
   * in the integrator's own console before it becomes a support ticket.
   */
  private sendSnapshot(): void {
    const frame: OutboundFrame = {
      type: "mirror",
      op: "snapshot",
      data: this.serializer.snapshot(),
      v: 1
    };
    // Serialized once. This used to stringify the snapshot, UTF-8 encode the whole of it to
    // read `.length`, throw both away, and then stringify it again in `send` — two full
    // stringifies and a byte-array copy of up to 4 MB, on page load, every SPA route change and
    // every agent attach.
    const text = JSON.stringify(frame);
    const bytes = byteLength(text);
    if (bytes > MAX_FRAME_BYTES) {
      this.onOversize(
        `snapshot is ${Math.round(bytes / 1024)} KB, over the ${MAX_FRAME_BYTES / 1024 / 1024} MB ` +
          "frame limit — the engine will close the connection. Reduce the page, or mask a large region."
      );
    }
    this.send({ serialized: text });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sendSnapshot();
    this.rememberSheetSizes();

    this.observer = new MutationObserver((records) => {
      // The batch is created, and the flush scheduled, only once a record has survived
      // `collect`. Committing up front sent an empty `mutate` frame for every callback in which
      // nothing was representable — and the dominant source of those is our own presence
      // overlay, which lives in the observed subtree, is rewritten on every inbound agent cursor
      // frame (20/s), and is deliberately never serialized. That is a frame per 50ms, per
      // pointing agent, stringified by the page, relayed by the engine and applied as a
      // four-empty-loop no-op by every console. An empty mutation carries no liveness meaning —
      // `ping` is a separate frame — so there is nothing to lose by not sending it.
      let batch: MirrorMutation | null = null;
      // Repeated `attributes` records for the same element are collapsed to the last one.
      // `attributesFor` reads the **live** element, so N records for one target produce N
      // identical entries — each paying a full classification, and each shipped and re-applied
      // by every console. An animation or drag loop writing `style` or `class` makes that 10-100
      // records for one node in a single callback. Only `attributes` is collapsed: `childList`
      // and `characterData` records describe distinct edits and are not interchangeable.
      // Order matters for `childList` and `characterData` — an add followed by a remove is not
      // the same as the reverse — so the pass below runs **forward**, and only the last
      // `attributes` record per target survives. Its index is found first.
      let lastAttr: Map<Element, number> | null = null;
      for (let i = 0; i < records.length; i++) {
        if (records[i]!.type !== "attributes") continue;
        lastAttr ??= new Map<Element, number>();
        lastAttr.set(records[i]!.target as Element, i);
      }
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        if (record.type === "attributes" && lastAttr!.get(record.target as Element) !== i) {
          continue;
        }
        batch ??= this.pending ?? empty();
        this.collect(record, batch);
      }
      if (!batch || isEmptyMutation(batch)) return;
      this.pending = batch;
      this.scheduleFlush();
    });
    this.observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    // A typed character changes a property, not an attribute, so nothing above sees it.
    this.listen(
      document,
      "input",
      (e) => {
        const target = e.target as Element | null;
        if (!target || target.nodeType !== 1) return;
        const id = this.serializer.id(target, false);
        if (id === undefined) return;
        const batch = (this.pending ??= empty());
        batch.attrs.push({ id, a: this.serializer.attributesFor(target) });
        this.scheduleFlush();
      },
      true
    );

    // Capture phase, on the document, so element scrolls arrive too — a `scroll` event on
    // a `<div>` does not bubble.
    this.listen(
      document,
      "scroll",
      (e) => {
        const target = e.target;
        if (target === document || target === window) {
          this.queueScroll(this.serializer.id(document, true), window.scrollX, window.scrollY);
          return;
        }
        const el = target as Element;
        if (!el || el.nodeType !== 1) return;
        const id = this.serializer.id(el, false);
        if (id === undefined) return;
        this.queueScroll(id, el.scrollLeft, el.scrollTop);
      },
      true
    );

    this.listen(window, "resize", () => {
      this.send({ type: "mirror", op: "viewport", data: viewportOf(document) });
    });

    this.sheetTimer = window.setInterval(() => this.pollSheets(), SHEET_POLL_MS);
  }

  stop(): void {
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    this.discardPending();
    // The sheet poll is the one timer `resync` keeps: it re-takes its baseline instead.
    if (this.sheetTimer !== null) window.clearInterval(this.sheetTimer);
    this.sheetTimer = null;
    for (const b of this.bound) b.target.removeEventListener(b.event, b.fn, b.capture);
    this.bound = [];
  }

  // -- collection ----------------------------------------------------------

  private listen(target: EventTarget, event: string, fn: EventListener, capture = false): void {
    target.addEventListener(event, fn, capture);
    this.bound.push({ target, event, fn, capture });
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.requestAnimationFrame(() => {
      this.flushTimer = null;
      const batch = this.pending;
      this.pending = null;
      if (batch) this.send({ type: "mirror", op: "mutate", data: batch });
    });
  }

  /** Drop everything collected but not yet sent, and the timers that would send it. */
  private discardPending(): void {
    this.pending = null;
    this.pendingScrolls.clear();
    if (this.flushTimer !== null) window.cancelAnimationFrame(this.flushTimer);
    this.flushTimer = null;
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
  }

  private queueScroll(id: number, x: number, y: number): void {
    this.pendingScrolls.set(id, { id, x, y });
    if (this.scrollTimer !== null) return;
    this.scrollTimer = window.setTimeout(() => {
      this.scrollTimer = null;
      const scrolls = [...this.pendingScrolls.values()];
      this.pendingScrolls.clear();
      if (!scrolls.length) return;
      const batch = (this.pending ??= empty());
      batch.scrolls = [...(batch.scrolls ?? []), ...scrolls];
      this.scheduleFlush();
    }, SCROLL_COALESCE_MS);
  }

  private collect(record: MutationRecord, batch: MirrorMutation): void {
    const targetId = this.serializer.id(record.target, false);
    if (targetId === undefined) return;

    if (record.type === "attributes") {
      const el = record.target as Element;
      if (el.nodeType !== 1) return;
      const entry: MirrorMutation["attrs"][number] = { id: targetId, a: this.serializer.attributesFor(el) };
      // A `rel` or `media` change can turn a link into a stylesheet or switch one off — but
      // nothing else about a `<style>` can, and re-reading it meant a full CSSOM walk,
      // `cssText` per rule and a `rewriteCssUrls` pass (up to the 512 KB cap) every time a
      // CSS-in-JS runtime touched a `data-*` on its own tag.
      const name = record.attributeName?.toLowerCase();
      const sheetChanged =
        name === undefined ||
        name === "rel" ||
        name === "media" ||
        name === "href" ||
        name === "type" ||
        name === "disabled";
      if (sheetChanged && isStyleBearing(el)) {
        const css = captureElementStyles(el, document.baseURI);
        if (css !== null) entry.css = css;
      }
      batch.attrs.push(entry);
      // Masking is not a one-time decision: an attribute change can make a field secret or
      // stop it being one, and the opaque set has to follow or the chokepoint would be
      // enforcing a stale answer.
      const reason = this.serializer.opaqueReason(el);
      if (reason) this.serializer.opaque.set(targetId, reason);
      else if (this.serializer.isMaskedField(el)) this.serializer.opaque.set(targetId, "masked");
      else this.serializer.opaque.delete(targetId);
      return;
    }

    if (record.type === "characterData") {
      const parent = record.target.parentElement;
      const value = record.target.textContent || "";
      const isStyle = parent !== null && parent.tagName === "STYLE";
      if (isStyle && parent) {
        // The text of a `<style>` changed. What matters is the resulting rules, which is
        // what the console renders.
        const parentId = this.serializer.id(parent, false);
        const css = captureElementStyles(parent, document.baseURI);
        if (parentId !== undefined && css !== null) {
          batch.attrs.push({ id: parentId, a: this.serializer.attributesFor(parent), css });
          return;
        }
      }
      batch.texts.push({
        id: targetId,
        // The same rule the snapshot path applies, asked of the same object. A live text
        // update that used a different predicate from the initial serialization would leak
        // exactly the text the snapshot had masked, one mutation later.
        v: isStyle || this.serializer.textLegible(record.target) ? value : maskText(value)
      });
      return;
    }

    for (let i = 0; i < record.removedNodes.length; i++) {
      const gone = record.removedNodes[i]!;
      const goneId = this.serializer.id(gone, false);
      if (goneId !== undefined) {
        batch.removes.push({ id: goneId, parent: targetId });
        this.serializer.forget(gone);
      }
    }
    for (let i = 0; i < record.addedNodes.length; i++) {
      const addedNode = record.addedNodes[i]!;
      const added = this.serializer.serialize(addedNode);
      if (!added) continue;
      const next = addedNode.nextSibling;
      batch.adds.push({
        parent: targetId,
        next: next ? (this.serializer.id(next, false) ?? null) : null,
        node: added
      });
      if (added.t === "el" && isStyleBearing(addedNode as Element)) {
        const el = addedNode as Element;
        this.sheetSizes.set(el, sheetSignature(el));
        // A `<link>` inserted by a code-split route has no `sheet` yet, so its rules are
        // captured on load rather than a second later by the poll. The poll is still the
        // backstop for a sheet that never fires one.
        if (el.tagName === "LINK") el.addEventListener("load", () => this.pollSheets(), { once: true });
      }
    }
  }

  // -- stylesheets that change without mutating -----------------------------

  private rememberSheetSizes(): void {
    for (const el of styleBearingElements()) this.sheetSizes.set(el, sheetSignature(el));
  }

  private pollSheets(): void {
    let batch: MirrorMutation | null = null;
    for (const el of styleBearingElements()) {
      const count = sheetSignature(el);
      if (this.sheetSizes.get(el) === count) continue;
      this.sheetSizes.set(el, count);
      const id = this.serializer.id(el, false);
      if (id === undefined) continue;
      const css = captureElementStyles(el, document.baseURI);
      if (css === null) continue;
      batch ??= this.pending ?? empty();
      batch.attrs.push({ id, a: this.serializer.attributesFor(el), css });
    }
    if (batch) {
      this.pending = batch;
      this.scheduleFlush();
    }
  }
}

function styleBearingElements(): Element[] {
  const out: Element[] = [];
  const nodes = document.querySelectorAll("style,link");
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]!;
    if (isStyleBearing(el)) out.push(el);
  }
  return out;
}

/**
 * A cheap signature of a stylesheet's current content.
 *
 * This was `cssRules.length`, and the comment beside it conceded the hole: **a rule edited in
 * place does not change the count**, so it was missed until the next snapshot — which on a page
 * that never navigates and never gains an agent means never. That is not a rare shape. It is
 * what a theme switcher does (`rule.style.setProperty` on a `:root` block), what an animation
 * library does when it drives a keyframe, and what a CSS-in-JS runtime does when it updates an
 * existing class rather than inserting one. The agent watches the customer click "dark mode" and
 * sees nothing happen.
 *
 * A real hash over every rule's text would be correct and is not affordable: this runs on every
 * sheet, every second, and `cssText` is a serialization the browser builds on demand — on a
 * utility-first framework's development build that is megabytes of string per poll.
 *
 * So: the count, plus the length of the first and last rule's text, plus a sample from the
 * middle. Rule count catches insert and delete; the sampled lengths catch an edit that changes
 * how much text a rule serializes to, which nearly every real edit does — a colour, a transform,
 * a display value. It is a heuristic, still, and it is a strictly wider one for a bounded cost:
 * three `cssText` reads rather than zero, against a poll that already walks every sheet.
 *
 * An edit that preserves the exact character count of the rule it touches — `#fff` to `#eee` —
 * is still missed until the next snapshot. That residue is named here rather than left implied.
 */
function sheetSignature(el: Element): number {
  const sheet = (el as HTMLStyleElement | HTMLLinkElement).sheet;
  if (!sheet) return -1;
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return -2; // cross-origin and unreadable, permanently
  }
  const n = rules.length;
  if (n === 0) return 0;
  let signature = n * 31;
  // First, middle, last. Three fixed probes, so the cost does not grow with the sheet.
  for (const i of n === 1 ? [0] : n === 2 ? [0, 1] : [0, n >> 1, n - 1]) {
    let text = "";
    try {
      text = rules[i]?.cssText ?? "";
    } catch {
      /* a rule that will not serialize; its absence is part of the signature */
    }
    signature = (signature * 33 + text.length) | 0;
  }
  return signature;
}

function empty(): MirrorMutation {
  return { adds: [], removes: [], attrs: [], texts: [] };
}

/** Nothing survived `collect`, so there is nothing for a console to apply. */
function isEmptyMutation(m: MirrorMutation): boolean {
  return (
    m.adds.length === 0 &&
    m.removes.length === 0 &&
    m.attrs.length === 0 &&
    m.texts.length === 0 &&
    !m.scrolls?.length
  );
}

/**
 * How large this frame will be on the wire, in bytes.
 *
 * `JSON.stringify` then a byte count, because the limit is bytes and the mirror carries text a
 * `.length` would undercount — a page in Japanese or with emoji in its labels is three or four
 * bytes per character where `String.length` says one. `TextEncoder` is universal in the browser
 * targets this bundle pins.
 */
/** Hoisted: constructing a `TextEncoder` per call was pure overhead. */
const ENCODER = new TextEncoder();

/** UTF-8 bytes, not `String.length` — the engine's limit is on bytes, and one emoji is four. */
function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}
