/**
 * The mirror node model — one type, two implementations, no drift.
 *
 * The SDK serializes the customer's document into these shapes and the console rebuilds
 * from them. Before this file the two ends were a TypeScript interface in the dashboard
 * and an untyped object literal in the SDK, and the fidelity failure that motivated phase
 * 2.5 lived exactly in that gap: the serializer emitted stylesheet text and the rebuilder
 * threw the `href` away, and nothing could have caught it because the contract existed
 * only in prose.
 *
 * `PROTOCOL.md` is the human-readable form of this file and must be changed with it.
 */

/**
 * Why the agent cannot be shown a node.
 *
 * The five node-marker values are pinned to `OpaqueReason` in
 * `crates/core/src/chokepoint/input.rs` and go into audit bodies, so they are never
 * renamed. `consent-surface` is not one of them: it is a refusal the SDK produces from
 * its own geometric check at dispatch time, never a marker on a serialized node.
 */
export type OpaqueReason =
  | "cross-origin-frame"
  | "closed-shadow-root"
  | "canvas"
  | "masked"
  | "unknown";

export type Refusal = OpaqueReason | "consent-surface";

export interface MirrorNode {
  id: number;
  t: "doc" | "dt" | "el" | "tx";
  /** element: tag name, lower-cased; doctype: name */
  n?: string;
  /** doctype public id */
  p?: string;
  /** doctype system id */
  s?: string;
  /** Namespace, when it is not HTML. Written for every node in the subtree, because a
   *  `<title>` inside SVG is not the `<title>` in HTML and creating it in the wrong
   *  namespace produces a different element. */
  ns?: "svg" | "mathml";
  a?: Record<string, string>;
  c?: MirrorNode[];
  /** text (`tx`) */
  v?: string;
  /**
   * Resolved stylesheet text, for `<style>` and `<link rel="stylesheet">`.
   *
   * Read from the CSSOM rather than from the text node, because a CSS-in-JS runtime that
   * builds its rules with `insertRule` leaves a `<style>` element whose text node is
   * empty — which is most of a modern application's styling. Every `url()` and `@import`
   * inside it has been resolved against the sheet's own base, so the console does not
   * resolve them against its own origin.
   *
   * When this is present the console renders a `<style>` in this node's position
   * whatever the original tag was, so the cascade order is the page's own.
   */
  css?: string;
  /** Opaque marker. A node carrying this has no children: the serializer stopped walking. */
  o?: OpaqueReason;
}

export interface MirrorSnapshot {
  root: MirrorNode;
  /** The customer's layout viewport. The console renders at exactly this size and scales
   *  the result, so the page's own media queries resolve the way they did on their
   *  screen. */
  viewport: { w: number; h: number };
  scroll: { x: number; y: number };
  href: string;
  /** `document.baseURI`. Everything URL-bearing is absolutized before it is sent, so this
   *  is for display and for the fallback `<base>` only. */
  base: string;
  /**
   * `document.adoptedStyleSheets`, already resolved. Constructed stylesheets are adopted
   * by reference and appear in no element, so a serializer that only walks the DOM misses
   * every one — which for a design system built on constructible stylesheets is all of
   * its styling.
   */
  adopted: string[];
  /** Elements scrolled away from their origin. No observer reports a scroll, and a chat
   *  panel or a virtualised list that mirrors at scrollTop 0 shows the agent a different
   *  page from the one the customer is looking at. */
  scrolls: { id: number; x: number; y: number }[];
  /** The protocol version this snapshot was produced by. */
  v: number;
}

export interface MirrorMutation {
  adds: { parent: number; next: number | null; node: MirrorNode }[];
  removes: { id: number; parent: number }[];
  attrs: { id: number; a: Record<string, string>; css?: string }[];
  texts: { id: number; v: string }[];
  /** Scroll offsets of scrollable elements, which no observer reports. */
  scrolls?: { id: number; x: number; y: number }[];
}

/** What the console shows in place of a region it was not given. */
export const OPAQUE_LABELS: Record<Refusal, string> = {
  "cross-origin-frame": "Another site's frame — not shown, not clickable",
  "closed-shadow-root": "A closed component — not shown, not clickable",
  canvas: "Canvas or video — not shown, not clickable",
  masked: "Hidden for privacy — not shown, not typeable",
  "consent-surface": "The customer's consent panel — never reachable",
  unknown: "Not shown, not clickable"
};
