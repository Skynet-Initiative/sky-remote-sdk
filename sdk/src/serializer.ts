/**
 * The DOM serializer.
 *
 * Written here rather than vendored, and the reasoning is
 * D-19: every node the serializer could not represent has
 * to be **marked with a reason** so the input chokepoint can refuse coordinates that land in
 * it, which is a change to the node model rather than an option on top of one, and the
 * console's rebuilder is ours regardless.
 *
 * What phase 2 owed and did not pay is fidelity. Owning the serializer means owning the
 * parts a session-replay library had already solved — the CSSOM, `@import` chains,
 * adopted stylesheets, URL resolution against a stylesheet's own base — and this file now
 * pays that bill. `harness/corpus` is the discipline that keeps it paid.
 *
 * ## What changed in the privacy rework
 *
 * D-19 also said masking had to be *inverted to default-on*, and this file implemented that
 * literally: every text node bulleted, every field opaque. Measured on the corpus it produced
 * a mirror with no legible text and no typeable field — see [`privacy.ts`](./privacy.ts) for
 * the measurements and the argument. The rule is now **protect values, not structure**, and
 * *which* values are sensitive is decided by the classifier in that file rather than by
 * whether the merchant remembered to list a selector.
 *
 * What did **not** change is the part D-19 was actually protecting: a field this file masks is
 * still marked opaque, so the chokepoint still refuses input into it, and `config.block`
 * regions are still inert and unwalked. The fail-closed paths are untouched; the default
 * posture is not.
 */

import type { MirrorNode, MirrorSnapshot, OpaqueReason } from "../../protocol/src/index.js";
import { absolutize, absolutizeSrcset, urlRole } from "../../protocol/src/index.js";
import type { ResolvedConfig } from "./config.js";
import { isSkyOwned } from "./dom.js";
import { isFieldProtected, textIsLegible, type FieldFacts } from "./privacy.js";
import { captureAdopted, captureElementStyles, isStyleBearing } from "./styles.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** Never mirrored. `<script>` is the page's code; `<template>` is inert; `<noscript>` is
 *  markup for a browser that is not this one and renders as visible text if copied. */
const SKIP_TAGS = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE"]);

/**
 * Attributes whose value is content rather than structure.
 *
 * Masked only where the surrounding text is — which in the standard tier means "inside a
 * region the merchant masked", not "everywhere".
 *
 * **These are labels, and bulleting them by default was a mistake of its own.** `alt`,
 * `placeholder`, `aria-label` and `title` are how a control announces what it is: an icon
 * button whose `aria-label` is `"••••••"` is unusable to a sighted agent and invisible to a
 * screen reader. They are authored by the merchant as part of the interface, not typed by the
 * customer — an `alt="Swatch"` is a product description. `value` is the exception and stays
 * with the field logic below, because it is the one entry here that holds what the customer
 * typed.
 *
 * `class`, `id`, `style`, `role` and every `data-*` are deliberately NOT here: they are what
 * the page's own CSS selects on, and masking them turns the mirror back into unstyled HTML.
 * `data-state="open"` is a component's state, not a customer's secret.
 */
const CONTENT_ATTRS = new Set(["placeholder", "title", "alt", "aria-label", "aria-placeholder"]);

/**
 * The tags that hold a customer-entered value, and are therefore the classifier's subject.
 *
 * One definition, because two places ask the question for two different reasons and a field
 * that is a field to one but not the other is exactly how a value gets masked on one path and
 * shipped on the other: `isMaskedField` asks "may the agent read this value", and
 * `textLegible` asks "is this text node inside something protected" — which is the `<select>`
 * case, where the value *is* the child text.
 */
const FIELD_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export interface SerializerHost {
  config: ResolvedConfig;
  /** Reported once per snapshot when fidelity was reduced, so the agent's console can say
   *  so rather than showing a page that is quietly wrong. */
  onDegraded?: (what: string) => void;
}

export class Serializer {
  private nextId = 1;
  /**
   * Node → id, and nothing the other way.
   *
   * There was an `id → Node` map beside this one. Nothing ever read it — the chokepoint
   * resolves coordinates against the **live** DOM rather than looking a node up by id, which
   * is the whole point of that design — and it was a strong `Map`, so it retained every node
   * it had ever seen. `MutationObserver.disconnect()` discards queued records, so a pause or
   * an SPA route change dropped exactly the removals that would have pruned it: a long
   * support session on a single-page app grew it by the whole of every route the customer
   * left. A `WeakMap` cannot leak, because the browser collects a detached node and the entry
   * goes with it.
   */
  private readonly idOf = new WeakMap<Node, number>();
  /** Regions the agent may not be shown, and may not act inside. */
  readonly opaque = new Map<number, OpaqueReason>();

  /**
   * Whether this element is representable to the agent, walking up and failing closed.
   *
   * **One predicate, two callers**, and that is the point rather than a tidiness note. Two
   * rules depend on it: the input chokepoint refuses an agent's coordinate inside a region we
   * did not transmit, and the presence channel refuses to report the *customer's* pointer from
   * inside one (D-26). Both are the same question — "did the agent ever see this?" — and both
   * were written out separately, in two files, each under a comment claiming the other was
   * being reused. They were copies, and only one had tests pointed at it.
   *
   * It lives here because this class owns both halves of the answer: `idOf` says whether the
   * node was ever emitted, `opaque` says whether it was emitted as a hole. A node the
   * serializer never emitted was never shown to the agent, and everything inside an opaque
   * subtree has no id at all, because `element()` stops walking at the marker.
   *
   * Returns the reason, `"unknown"` for a node that was never emitted, or `null` when the
   * element is representable. Callers decide what to do with each; they do not re-derive it.
   */
  representability(from: Element | null): OpaqueReason | "unknown" | null {
    for (let n: Element | null = from; n && n.nodeType === 1; n = n.parentElement) {
      // Our own chrome is not the customer's page. A pointer over it is a real position on a
      // real page and the elements are simply not part of what we were asked to represent, so
      // this is representable rather than a refusal — the caller stops climbing here.
      if (isSkyOwned(n)) return null;
      const id = this.id(n, false);
      if (id === undefined) return "unknown";
      const reason = this.opaque.get(id);
      if (reason) return reason;
    }
    return null;
  }
  private base = "";
  private scrolls: { id: number; x: number; y: number }[] = [];

  constructor(private readonly host: SerializerHost) {}

  // -- identity ------------------------------------------------------------

  id(node: Node, create: true): number;
  id(node: Node, create: false): number | undefined;
  id(node: Node, create: boolean): number | undefined {
    let id = this.idOf.get(node);
    if (id === undefined && create) {
      id = this.nextId++;
      this.idOf.set(node, id);
    }
    return id;
  }

  /** A removed subtree's opaque markers are dropped, so the set cannot grow without bound.
   *  The ids themselves need no pruning: `idOf` is weak. */
  forget(node: Node): void {
    const id = this.idOf.get(node);
    if (id !== undefined) this.opaque.delete(id);
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) this.forget(kids[i]!);
  }

  reset(): void {
    this.opaque.clear();
  }

  // -- the snapshot --------------------------------------------------------

  snapshot(doc: Document = document): MirrorSnapshot {
    this.opaque.clear();
    this.scrolls = [];
    this.base = doc.baseURI;
    const root = this.serialize(doc)!;
    const view = doc.defaultView;
    return {
      root,
      viewport: viewportOf(doc),
      scroll: { x: view ? view.scrollX : 0, y: view ? view.scrollY : 0 },
      href: doc.location ? doc.location.href : this.base,
      base: this.base,
      adopted: captureAdopted(doc),
      scrolls: this.scrolls,
      v: 1
    };
  }

  // -- one node ------------------------------------------------------------

  serialize(node: Node): MirrorNode | null {
    switch (node.nodeType) {
      case 9: {
        // Document
        const id = this.id(node, true);
        return { id, t: "doc", c: this.children(node) };
      }
      case 10: {
        // DocumentType
        const dt = node as DocumentType;
        const id = this.id(node, true);
        return { id, t: "dt", n: dt.name, p: dt.publicId, s: dt.systemId };
      }
      case 1:
        return this.element(node as Element);
      case 3: {
        // Text
        const id = this.id(node, true);
        const parent = node.parentElement;
        const text = node.textContent || "";
        // Stylesheet text is layout, not content, and masking it would destroy the page
        // the agent is looking at. The `css` field on the parent supersedes it, but a
        // `<style>` the browser has not parsed still renders from here.
        const isStyle = parent !== null && parent.tagName === "STYLE";
        return { id, t: "tx", v: isStyle || this.textLegible(node) ? text : maskText(text) };
      }
      default:
        return null; // comments, CDATA, processing instructions
    }
  }

  private element(el: Element): MirrorNode | null {
    if (SKIP_TAGS.has(el.tagName)) return null;
    // Nothing this SDK put on the page is ever mirrored. The consent frame is cross-origin and
    // would be opaque anyway, but the presence overlay and the injected `<style>` are ordinary
    // same-origin nodes we created, so nothing else would stop them: the overlay would be
    // serialized and rendered a second time in the console — an echo chasing the real cursor,
    // one frame behind — and the stylesheet would ship our own dialog CSS as page content.
    if (isSkyOwned(el)) return null;
    if (!this.renderable(el)) return null;

    const id = this.id(el, true);
    const reason = this.opaqueReason(el);
    const out: MirrorNode = {
      id,
      t: "el",
      n: el.tagName.toLowerCase(),
      a: this.attributes(el, reason !== null)
    };
    const ns = namespaceOf(el);
    if (ns) out.ns = ns;

    if (isStyleBearing(el)) {
      const css = captureElementStyles(el, this.base);
      if (css !== null) {
        out.css = css;
      } else if (el.tagName === "LINK") {
        // Unreadable cross-origin sheet. The href survives so the console can load it,
        // bounded by the mirror document's own CSP.
        this.host.onDegraded?.(`stylesheet not readable: ${el.getAttribute("href") ?? "?"}`);
      }
    }

    if (reason) {
      // Marked, and its children are not walked. The console renders it as an explicitly
      // inert rectangle with this reason, and the input chokepoint refuses coordinates
      // that land inside it (docs/03 §2c).
      this.opaque.set(id, reason);
      out.o = reason;
      out.c = [];
      return out;
    }

    if (this.isMaskedField(el)) {
      // A field whose contents the agent cannot read is a field they may not type into.
      // Refuse-list item 6: no "let the agent type the customer's password".
      this.opaque.set(id, "masked");
      out.o = "masked";
      // **Its children are not walked either**, and a `<select>` is why.
      //
      // For an `<input>` this is a distinction without a difference: the value is a property,
      // it is masked in `attributes()`, and there are no element children to leak. A `<select>`
      // holds its values as `<option>` text — real children, serialized by the loop below —
      // so a select the classifier protected shipped `o: "masked"` *and* the full option list
      // in the clear on the same node. The console drops an opaque node's children when it
      // rebuilds, which is exactly what hid this: the leak was on the wire, never on screen,
      // and no fidelity assertion could have caught it.
      //
      // Same shape as the `reason` branch above, and for the same reason — "the agent may not
      // read this" has to mean the subtree, not the element.
      out.c = [];
      return out;
    }
    this.opaque.delete(id);

    this.recordScroll(el, id);
    out.c = this.children(el);
    return out;
  }

  private children(node: Node): MirrorNode[] {
    const out: MirrorNode[] = [];
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = this.serialize(kids[i]!);
      if (child) out.push(child);
    }
    return out;
  }

  /**
   * Elements that exist in the document and must not exist in the mirror.
   *
   * A `<link rel="preload">` would make the agent's browser fetch a resource chosen by
   * the customer's page for no rendering benefit. A `<meta http-equiv>` is worse: a
   * `Content-Security-Policy` or a `refresh` copied into the mirror document applies to
   * the mirror document, so the customer's page could switch off the console's own
   * rendering or navigate the frame.
   */
  private renderable(el: Element): boolean {
    if (el.tagName === "LINK") return isStyleBearing(el);
    if (el.tagName === "META") return el.getAttribute("http-equiv") === null;
    if (el.tagName === "BASE") return false; // every URL is absolute by the time it ships
    return true;
  }

  private recordScroll(el: Element, id: number): void {
    const x = el.scrollLeft;
    const y = el.scrollTop;
    if (x || y) this.scrolls.push({ id, x, y });
  }

  // -- what the agent may not see or touch ---------------------------------

  /**
   * Why the agent cannot be shown this node, or null if they can.
   *
   * The list is closed on purpose: an "unknown" default that meant "representable" would
   * silently open the blind-click hole the whole rule exists to close, so anything not
   * understood is opaque.
   */
  opaqueReason(el: Element): OpaqueReason | null {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "iframe" || tag === "frame" || tag === "object" || tag === "embed") {
      // We serialize only our own document. A frame's contents need the SDK inside them
      // too, which is an integration requirement for the merchant rather than a bug we
      // can fix (D-19). Until then the agent sees a rectangle, and may not click into it.
      return "cross-origin-frame";
    }
    if (tag === "canvas" || tag === "video" || tag === "audio") return "canvas";
    // **Any shadow host is opaque**, open or closed, because `childNodes` never contains
    // a shadow tree. `attachShadow` works on a plain `div` too, so the test is the
    // property and not the tag name. A closed root reports `shadowRoot === null` and is
    // caught by a custom element having no serializable children.
    if ((el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot) return "closed-shadow-root";
    if (
      (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot === null &&
      isCustomElement(el) &&
      el.childNodes.length === 0
    ) {
      return "closed-shadow-root";
    }
    // `block` is the strongest lever a merchant has and the only one that removes a region
    // from the tree entirely: children are not walked, the rectangle is inert, and the
    // chokepoint refuses coordinates inside it. `mask` is the lighter one — text is bulleted
    // but the layout survives, so the agent still sees the shape of the page. Two levers
    // because "hide this value" and "this region does not exist for you" are different asks,
    // and collapsing them into one forced merchants to choose between a readable page and a
    // protected one.
    if (this.matches(el, this.host.config.block)) return "masked";
    return null;
  }

  /**
   * Is this field's value one the agent may not read — and therefore may not type into?
   *
   * The two halves are the same question by design (the trust model
   * §2c): a field whose contents the agent cannot see is a field they cannot be allowed to
   * act inside, or they would be typing into a form they cannot read on the customer's
   * behalf. `element()` marks anything this returns true for as opaque, which is what the
   * chokepoint enforces against.
   *
   * The decision itself lives in `privacy.ts`. This method's only job is to gather the facts
   * from the DOM, so that the classifier stays testable without one.
   */
  isMaskedField(el: Element): boolean {
    if (!FIELD_TAGS.has(el.tagName)) return false;
    if (this.maskedFieldMemo?.el === el) return this.maskedFieldMemo.value;
    // A field inside a region the merchant masked is protected whatever the classifier thinks and
    // whatever an allowlist says. Checked here rather than inside the classifier because it is a
    // question about the element's ancestors, and checked *first*, because `mask` is the
    // merchant's own answer and it has to beat both — that ordering was a real bug: `.rr-mask` on
    // an input masked the label beside it and shipped the value in the clear, typeable.
    const { masked, allowed } = this.ancestry(el);
    const value = masked || isFieldProtected(this.facts(el), this.host.config.privacy, allowed);
    this.maskedFieldMemo = { el, value };
    return value;
  }

  /**
   * The last `isMaskedField` answer, for the duration of one `attributes()` call.
   *
   * One `attributesFor(<input>)` asked it three times — directly, again via `textLegible`'s
   * `FIELD_TAGS` branch, and again for the live `value` — each one an `ancestry()` climb, a
   * `facts()` build (which concatenates `name`/`id`/`className` and copies the value) and a
   * classifier run. `isSensitiveField` reaches `label()` whenever type, autocomplete and name
   * are inconclusive, which is the common case for an ordinary text field, so that was up to
   * three document-scoped `label[for=…]` queries per keystroke.
   *
   * Deliberately a single slot keyed on the element, not a cache: it is invalidated by asking
   * about any other element, so it cannot outlive the call that filled it and cannot answer for
   * a field whose DOM has since changed. The live DOM is still what every fresh call reads.
   */
  private maskedFieldMemo: { el: Element; value: boolean } | null = null;

  /** What the classifier needs, read once. */
  private facts(el: Element): FieldFacts {
    const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const value = "value" in field && field.value != null ? String(field.value) : "";
    return {
      tag: el.tagName,
      type: fieldType(el),
      autocomplete: el.getAttribute("autocomplete") ?? "",
      identity: `${el.getAttribute("name") ?? ""} ${el.id} ${el.className}`,
      label: () => labelTextOf(el),
      value
    };
  }

  /**
   * Is this node's text legible in this tier?
   *
   * A masked region wins over an allowed one, and both are checked on the way up so that a
   * sensitive subtree inside an allowed page stays masked. In the standard tier the answer is
   * "yes unless masked", which is the readability fix; in strict it is "only if allowed".
   */
  textLegible(node: Node): boolean {
    const el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const { masked, allowed } = this.ancestry(el);
    if (masked) return false;
    // A protected FIELD's text is not legible either, and a `<select>` is the case that makes
    // this more than a tautology: its values are `<option>` text nodes, so the mutation path
    // asked this question about a text node whose parent chain the *classifier* had protected
    // and the *selectors* had said nothing about. `ancestry()` answers for `mask`/`block`/
    // `unmask`; it cannot answer for "this field looks like a card number".
    //
    // Checked on the way up rather than on `el` alone, because the text node's parent is the
    // `<option>` and the protected element is the `<select>` above it.
    for (let n: Element | null = el; n; n = n.parentElement) {
      if (FIELD_TAGS.has(n.tagName)) return !this.isMaskedField(n);
    }
    return textIsLegible(this.host.config.privacy, allowed);
  }

  /**
   * The privacy verdict for a node's ancestry, in ONE walk.
   *
   * There were two walks over the same parent chain: `mask` in one and `block`/`unmask` in the
   * other, so every text node and every field climbed to `<html>` twice. Worse, `attributes()`
   * asked `textLegible()` and `isMaskedField()` about the same element and each climbed again — four
   * traversals per input, on the path that also runs on every keystroke.
   *
   * One pass, first decisive answer wins, preserving the precedence the separate walks had:
   * `mask` beats `unmask`, and `block` stops an `unmask` above it from applying.
   */
  private ancestry(from: Element | null): { masked: boolean; allowed: boolean } {
    const { mask, block, unmask } = this.host.config;
    for (let el: Element | null = from; el; el = el.parentElement) {
      if (this.matches(el, mask)) return { masked: true, allowed: false };
      if (this.matches(el, block)) return { masked: false, allowed: false };
      if (unmask.length && this.matches(el, unmask)) return { masked: false, allowed: true };
    }
    return { masked: false, allowed: false };
  }

  /**
   * Does this element match any of these selectors?
   *
   * No `try/catch`. There used to be one, returning `false` on a throw — and this helper is
   * what `opaqueReason` uses to apply `config.block`, so "false" there means the element is
   * NOT marked masked and IS shown to the agent. That is fail-open, in the code path that
   * decides what a stranger sees of a customer's page, and it directly contradicts D-19's
   * rule one file over: `compileSelectors` validates every selector at configure time and
   * refuses to stream on a bad one, precisely so that masking less than the page asked for
   * is never something that happens quietly.
   *
   * One authoritative place, and it already fails closed. A second answer here could only
   * ever disagree with it.
   */
  private matches(el: Element, selectors: readonly string[]): boolean {
    if (!selectors.length || !el.matches) return false;
    for (const selector of selectors) {
      if (el.matches(selector)) return true;
    }
    return false;
  }

  // -- attributes ----------------------------------------------------------

  /** Attributes for an element whose opacity has not already been decided — the mutation
   *  path, where the reason has to be recomputed anyway. */
  attributesFor(el: Element): Record<string, string> {
    this.maskedFieldMemo = null;
    const opaque = this.opaqueReason(el) !== null || this.isMaskedField(el);
    const out = this.attributes(el, opaque, true);
    this.maskedFieldMemo = null;
    return out;
  }

  attributes(el: Element, opaque = false, keepMemo = false): Record<string, string> {
    if (!keepMemo) this.maskedFieldMemo = null;
    const out: Record<string, string> = {};
    // Labels follow the surrounding text rather than the field's own sensitivity: the
    // placeholder on a card field is "MM/YY", which is the merchant's wording and is what
    // tells the agent what the field is. The customer's typed value is handled separately
    // below and is the only thing here that can leak what they entered.
    //
    // **Computed on first use, not up front.** `textLegible` walks to `<html>` matching every
    // `mask` selector at each level, and it is read only inside the `CONTENT_ATTRS` branch
    // below — which most elements never enter, because most elements have no `placeholder`,
    // `title`, `alt` or `aria-label`. Eagerly it was one full ancestor climb per element per
    // snapshot; on a 5,000-node page at mean depth 18 that is most of the serializer's work,
    // spent on an answer nobody asked for.
    let legible: boolean | undefined;
    const labelsLegible = (): boolean => (legible ??= this.textLegible(el));
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i]!;
      const name = a.name;
      const lower = name.toLowerCase();
      // Event handlers are never mirrored: they are the page's code, not its content, and
      // the console must never be handed something it could be tricked into running.
      if (lower.slice(0, 2) === "on") continue;
      let value = a.value;

      // A stale `value` attribute is the page's initial state; the live property below
      // supersedes it. Dropped here so a protected field cannot leak its value through the
      // attribute after the property has been masked.
      if (lower === "value" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) continue;

      if (CONTENT_ATTRS.has(lower) && !labelsLegible()) value = maskText(value);

      const role = urlRole(lower);
      if (role) {
        // A node the agent may not be shown keeps none of its URLs. An `<iframe>` marked
        // `cross-origin-frame` still has a `src`, and a rebuilder that set it would make
        // the agent's browser load the third-party frame we just refused to serialize.
        if (opaque) continue;
        if (lower === "srcset") {
          const resolved = absolutizeSrcset(value, this.base);
          if (resolved === null) continue;
          value = resolved;
        } else {
          if (
            lower === "src" &&
            el.tagName === "IMG" &&
            value.length > MAX_INLINE_IMAGE &&
            /^data:/i.test(value.trim())
          ) {
            // A data: URL can be megabytes, and one that large is a payload rather than a
            // picture. Small ones are kept: inline SVG icons and base64 logos are how a great
            // many sites draw their interface, and dropping every one of them rendered a
            // broken box in place of the button the agent was being asked about. The bound is
            // on size rather than on the scheme, because size is the actual problem.
            this.host.onDegraded?.(`inline image too large to mirror: ${value.length} bytes`);
            continue;
          }
          const resolved = absolutize(value, this.base);
          if (resolved === null) continue;
          value = resolved;
        }
      }
      out[name] = value;
    }

    // Live properties. A field's current value, a checkbox's state and a selected option
    // are properties rather than attributes, so nothing above sees them and the agent
    // would be shown the page's initial state instead of what the customer did.
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      const live = field.value == null ? "" : String(field.value);
      // The one authority on whether this value may be read, shared with the chokepoint.
      // Bulleted rather than dropped, so the agent can see that the customer is typing and
      // how much — which is what makes "read me the last four digits" a usable instruction —
      // without seeing what.
      out.value = this.isMaskedField(el) ? maskText(live) : live;
      const inputType = fieldType(el);
      if (el.tagName === "INPUT" && (inputType === "checkbox" || inputType === "radio")) {
        if ((field as HTMLInputElement).checked) out.checked = "";
        else delete out.checked;
      }
    }
    if (el.tagName === "OPTION") {
      if ((el as HTMLOptionElement).selected) out.selected = "";
      else delete out.selected;
    }
    return out;
  }
}

// -- helpers ---------------------------------------------------------------

/**
 * The largest inline image that ships, in characters of data URL.
 *
 * 32 KB of base64 is roughly 24 KB of image: comfortably enough for icons, sprites, inline
 * SVG and a logo, and far below the size where a single node would stall a mirror frame on a
 * support-desk connection.
 */
const MAX_INLINE_IMAGE = 32 * 1024;

/**
 * What this field is called, according to the page.
 *
 * Used by the classifier so that a field labelled "Security code" is protected even when its
 * `name`, `id` and `autocomplete` are all anonymous — which is what a form generated by a
 * component library tends to look like.
 *
 * `aria-label` first, then the `<label>` associated by `for` or by wrapping. Deliberately does
 * **not** fall back to nearby text: a heuristic that walked previous siblings would classify
 * every field under a "Payment" heading as sensitive, which is the over-matching that made the
 * old version unusable.
 */
function labelTextOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const doc = el.ownerDocument;
  if (el.id && doc) {
    try {
      // `CSS.escape` because an id may contain characters that are not valid in a selector —
      // a colon or a bracket from a utility-class framework would otherwise throw.
      const escaped = doc.defaultView?.CSS?.escape?.(el.id) ?? el.id;
      const label = doc.querySelector(`label[for="${escaped}"]`);
      if (label?.textContent) return label.textContent;
    } catch {
      // An id no selector can express. The wrapping label below still applies.
    }
  }
  const wrapping = el.closest?.("label");
  return wrapping?.textContent ?? "";
}

/** One reading of a field's `type`, with one default. It was read in two places with the same
 *  `|| "text"` fallback, which is two places to keep in step. */
function fieldType(el: Element): string {
  return (el.getAttribute("type") || "text").toLowerCase();
}

function isCustomElement(el: Element): boolean {
  return typeof el.tagName === "string" && el.tagName.indexOf("-") > 0;
}

function namespaceOf(el: Element): "svg" | "mathml" | undefined {
  if (el.namespaceURI === SVG_NS) return "svg";
  if (el.namespaceURI === MATHML_NS) return "mathml";
  return undefined;
}

/**
 * Text, masked unless opted out.
 *
 * Length is preserved so the agent sees the shape of the page rather than an empty one,
 * and so a masked field does not reflow the layout they are looking at. Digits and letters
 * both become the same character: preserving the character *class* would leak the format
 * of a card number or a postcode, which is most of what makes it identifying.
 */
export function maskText(value: string): string {
  return value.replace(/\S/g, "•");
}

export function viewportOf(doc: Document): { w: number; h: number } {
  const view = doc.defaultView;
  return {
    w: doc.documentElement.clientWidth || (view ? view.innerWidth : 0),
    h: doc.documentElement.clientHeight || (view ? view.innerHeight : 0)
  };
}
