/**
 * The DOM mirror rebuilder — the agent's half of the co-browse data plane.
 *
 * The SDK serializes the customer's document into the node model in
 * `@skynet-initiative/sky-remote-protocol`; this rebuilds it. The two are one contract with
 * two implementations, and the engine deliberately sits between them without understanding
 * either: it relays mirror frames verbatim.
 *
 * **What is rendered is untrusted content from someone else's website.** Three rules
 * follow and none is negotiable:
 *
 *  1. It goes into an iframe with `sandbox="allow-same-origin"` and NOT `allow-scripts`.
 *     Same-origin so this code can build nodes inside it; no scripts so nothing in it can
 *     run — no `<script>`, no `onclick`, no `javascript:` URL. The serializer already
 *     drops those; this is the layer that does not depend on it having.
 *
 *     **This rule is the caller's to keep, and this file cannot keep it.** `Mirror` is handed
 *     a `Document`; it does not create the frame, so the sandbox attribute is set in the
 *     console — a different application, in a different repository. Rules 2 and 3 are enforced
 *     here and hold whatever the caller does; rule 1 was written in the same list as though it
 *     were too, which reads as a guarantee this package makes. `assertSandboxed()` below is
 *     what makes it checkable: it is called on the first snapshot and throws if the document
 *     it was given can run scripts. Refusing to render is the correct answer — a mirror that
 *     executes a stranger's page in the agent's console is the one failure in this product
 *     that cannot be walked back.
 *  2. Nothing here is ever `innerHTML`. Every node is constructed from the typed model, so
 *     a string that looks like markup stays a string.
 *  3. The mirror document carries **its own `<meta>` Content-Security-Policy**, which
 *     bounds what the whole document may fetch regardless of what any attribute says. That
 *     closes the class rather than the instance: an attribute filter is a list that can be
 *     incomplete, and this one was — it was case-sensitive while `setAttribute`
 *     lower-cases, and `<style>` text was rebuilt with no URL filtering at all.
 *
 * ## Why this file used to show unstyled HTML
 *
 * It treated every URL-bearing attribute as a request-forgery risk and moved all of them
 * to `data-sky-*`, restoring only `<img src>`. A `<link rel="stylesheet">` therefore never
 * got an `href` and no stylesheet ever loaded. The rule that replaces it is in
 * `protocol/src/urls.ts`, shared with the end that writes the URLs, and the CSP above is
 * what makes the rule safe to relax.
 *
 * Regions the serializer could not represent arrive marked with a reason and are rendered
 * as explicitly inert. That is half of the blind-click rule: the agent is told why a region
 * is dead rather than being left to think it is a bug. The other half — refusing input into
 * it — is enforced in the SDK, at the single place input reaches the page.
 */

import {
  OPAQUE_LABELS,
  isFetchable,
  rewriteCssUrls,
  urlRole,
  type MirrorMutation,
  type MirrorNode,
  type MirrorSnapshot,
  type Refusal
} from "../../protocol/src/index.js";

export type {
  MirrorMutation,
  MirrorNode,
  MirrorSnapshot,
  OpaqueReason,
  Refusal
} from "../../protocol/src/index.js";
export { OPAQUE_LABELS } from "../../protocol/src/index.js";

/**
 * The consent theme validator, re-exported for the dashboard.
 *
 * It belongs to the consent surface and it is exported here because the dashboard has to
 * give an operator the same verdict the panel will give — "your brand colour is too close
 * to the panel's background" has to appear when they save it, not when a customer meets it.
 *
 * The same function in both places, deliberately. A second implementation for the preview
 * would be a second opinion about what is safe, and the one that mattered would be the one
 * nobody was looking at.
 */
export {
  contrast,
  parseColor,
  resolveTheme,
  sanitizeFontStack,
  type ConsentTheme,
  type ResolvedTheme
} from "../../protocol/src/index.js";

/**
 * The key allowlist, re-exported for the console.
 *
 * The console has to apply it before sending: the engine rejects an unknown key as a
 * malformed frame rather than refusing it, which reaches the agent as an error toast rather
 * than as a rule. It had its own thirteen-entry copy with a comment conceding the copy could
 * drift — while the SDK already imported this one, so only the console could disagree.
 *
 * One list, three peers.
 */
export { NAMED_KEYS, isSendableKey } from "../../protocol/src/index.js";

/**
 * The presence cursor's rate and its idle timeout, re-exported for the console.
 *
 * For the same reason `NAMED_KEYS` is: three peers, one number. The SDK and the console both
 * throttle to `PRESENCE_THROTTLE_MS` and the engine deliberately does not police it, so a
 * private copy in the console would be the one place the rate could drift with nothing to
 * notice — and the symptom would be a cursor that stutters against one end and not the other,
 * which reads as a network problem rather than as a constant nobody kept in step.
 *
 * The idle timeout travels with it because the two are related: a receiver that hides a cursor
 * after less than a few send intervals would flicker on ordinary jitter.
 */
export {
  PRESENCE_IDLE_MS,
  PRESENCE_THROTTLE_MS,
  type PresenceCursor
} from "../../protocol/src/index.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/**
 * What the mirror document may fetch, stated once, in the document itself.
 *
 * `script-src 'none'` is belt to the sandbox's braces. `frame-src 'none'` matters more
 * than it looks: an `<iframe>` in the customer's page arrives marked opaque, and a
 * rebuilder that set its `src` would make the agent's browser load a third party the
 * serializer had just refused to represent.
 */
const MIRROR_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https: http:",
  "img-src https: http: data:",
  "font-src https: http: data:",
  "media-src 'none'",
  "script-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

/**
 * The striping that makes an inert region legible as a rule rather than as a rendering
 * failure — and nothing else.
 *
 * It deliberately does not reset `html`/`body` margins. It used to, and that is a fidelity
 * bug in the shape this whole phase is about: a page that relies on the user agent's
 * default 8px body margin renders flush to the edge in the mirror and nowhere else. The
 * mirror inherits the same user-agent stylesheet the customer's browser applied, so
 * anything this file "normalises" is a difference it is introducing.
 */
const CONSOLE_STYLE = `
  [data-sky-opaque]{
    position:relative;
    background:repeating-linear-gradient(45deg,#f2f4f7,#f2f4f7 6px,#e6e9ef 6px,#e6e9ef 12px);
    outline:1px dashed #a9b1bd;min-width:8px;min-height:8px;color:#5b6672;
  }
  [data-sky-opaque]::after{
    content:attr(data-sky-opaque-label);position:absolute;inset:0;display:flex;
    align-items:center;justify-content:center;font:11px/1.2 system-ui,sans-serif;
    text-align:center;padding:2px;pointer-events:none;
  }
`;

export class Mirror {
  private readonly doc: Document;
  private readonly nodes = new Map<number, Node>();
  /** The reverse of `nodes`, so a removed subtree's ids can be found from its DOM. Weak, so
   *  it cannot itself become the leak it exists to close. */
  private readonly idOf = new WeakMap<Node, number>();
  private adoptedEl: HTMLStyleElement | null = null;
  constructor(doc: Document) {
    this.doc = doc;
  }

  /** Replace everything. Called on the initial snapshot and on any resync. */
  applySnapshot(snapshot: MirrorSnapshot): void {
    assertSandboxed(this.doc);
    this.nodes.clear();
    this.adoptedEl = null;

    this.doc.open();
    this.doc.write(
      "<!doctype html><html><head>" +
        `<meta http-equiv="Content-Security-Policy" content="${MIRROR_CSP}">` +
        "</head><body></body></html>"
    );
    this.doc.close();

    const style = this.doc.createElement("style");
    style.textContent = CONSOLE_STYLE;
    style.setAttribute("data-sky-console", "");
    this.doc.head.appendChild(style);

    const root = snapshot.root;
    this.remember(root.id, this.doc);
    for (const child of root.c ?? []) {
      if (child.t === "dt") continue; // the doctype is already written
      this.buildInto(this.doc.documentElement, child, null, true);
    }

    // Adopted stylesheets are applied after the document's own, which is where the
    // specification puts them and therefore where the cascade expects them.
    this.applyAdopted(snapshot.adopted ?? []);

    for (const { id, x, y } of snapshot.scrolls ?? []) this.scrollElement(id, x, y);
    this.doc.defaultView?.scrollTo(snapshot.scroll?.x ?? 0, snapshot.scroll?.y ?? 0);
  }

  applyMutation(m: MirrorMutation): void {
    for (const { id } of m.removes ?? []) {
      const node = this.nodes.get(id);
      // Forgotten BEFORE detaching, while the subtree is still walkable.
      this.forget(node, id);
      if (node?.parentNode) node.parentNode.removeChild(node);
    }
    for (const { parent, next, node } of m.adds ?? []) {
      const parentNode = this.nodes.get(parent);
      if (!parentNode) continue;
      const before = next === null ? null : (this.nodes.get(next) ?? null);
      this.buildInto(parentNode as Element, node, before, false);
    }
    for (const entry of m.attrs ?? []) {
      const node = this.nodes.get(entry.id);
      if (!node || node.nodeType !== 1) continue;
      const el = node as Element;
      this.setAttributes(el, entry.a);
      if (entry.css !== undefined) this.setStyleText(el, entry.css);
    }
    for (const { id, v } of m.texts ?? []) {
      const node = this.nodes.get(id);
      if (node && node.nodeType === 3) node.textContent = v;
    }
    for (const { id, x, y } of m.scrolls ?? []) this.scrollElement(id, x, y);
  }

  applyScroll(x: number, y: number): void {
    this.doc.defaultView?.scrollTo(x, y);
  }

  /**
   * Which region a point in the customer's viewport lands in, if it is inert.
   *
   * Advisory only, and worth saying why: this is the console's copy of the answer, used to
   * warn the agent BEFORE they click. The enforcing copy is the SDK's, at the moment of
   * dispatch, against the live page. If the two ever disagree the SDK's wins, because a
   * console that could talk itself into a click would not be a chokepoint at all.
   */
  opaqueAt(x: number, y: number): Refusal | null {
    const el = this.doc.elementFromPoint?.(x, y);
    for (let n: Element | null = el ?? null; n; n = n.parentElement) {
      const reason = n.getAttribute?.("data-sky-opaque");
      if (reason) return reason as Refusal;
    }
    return null;
  }

  // -- internals -----------------------------------------------------------

  private remember(id: number, node: Node): void {
    this.nodes.set(id, node);
    this.idOf.set(node, id);
  }

  private scrollElement(id: number, x: number, y: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.nodeType === 9) {
      this.doc.defaultView?.scrollTo(x, y);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    el.scrollLeft = x;
    el.scrollTop = y;
  }

  private applyAdopted(sheets: string[]): void {
    if (!sheets.length) return;
    if (!this.adoptedEl) {
      this.adoptedEl = this.doc.createElement("style");
      this.adoptedEl.setAttribute("data-sky-adopted", "");
      this.doc.head.appendChild(this.adoptedEl);
    }
    this.adoptedEl.textContent = sheets.map((css) => filterCss(css)).join("\n");
  }

  /**
   * Drop a removed node's id, and every id beneath it.
   *
   * It used to delete only the top-level id, so every descendant's `id → Node` entry stayed
   * — holding the whole detached subtree alive in the agent's browser. On a single-page app
   * the customer navigates, that is the entire previous route retained per navigation, for
   * the length of the session. The SDK's own `forget` recurses; this side did not.
   *
   * Walked before the node leaves the document, so `childNodes` is still populated.
   */
  private forget(node: Node | undefined, id: number): void {
    this.nodes.delete(id);
    if (!node) return;
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      const childId = this.idOf.get(child);
      if (childId !== undefined) this.forget(child, childId);
    }
  }

  private buildInto(parent: Node, model: MirrorNode, before: Node | null, replaceRoot: boolean): void {
    if (replaceRoot && model.t === "el" && model.n === "html") {
      // The snapshot's <html> carries the page's own attributes; its children become the
      // document's head and body rather than a second <html> inside one.
      this.setAttributes(this.doc.documentElement, model.a ?? {});
      this.remember(model.id, this.doc.documentElement);
      for (const child of model.c ?? []) this.buildInto(this.doc.documentElement, child, null, true);
      return;
    }
    if (replaceRoot && model.t === "el" && (model.n === "head" || model.n === "body")) {
      const target = model.n === "head" ? this.doc.head : this.doc.body;
      this.setAttributes(target, model.a ?? {});
      this.remember(model.id, target);
      for (const child of model.c ?? []) this.buildInto(target, child, null, false);
      return;
    }
    const node = this.build(model);
    if (!node) return;
    parent.insertBefore(node, before);
  }

  private build(model: MirrorNode): Node | null {
    switch (model.t) {
      case "tx": {
        const text = this.doc.createTextNode(model.v ?? "");
        this.remember(model.id, text);
        return text;
      }
      case "el": {
        // A node carrying resolved stylesheet text becomes a `<style>` **in this
        // position**, whatever the original tag was, so the cascade order is the page's
        // own. A `<link rel=stylesheet>` rebuilt as a link at the end of head would apply
        // its rules in a different order from the page it is mirroring.
        if (model.css !== undefined) {
          const style = this.doc.createElement("style");
          style.setAttribute("data-sky-from", model.n ?? "style");
          style.textContent = filterCss(model.css);
          this.remember(model.id, style);
          return style;
        }
        const el = this.create(model);
        this.remember(model.id, el);
        this.setAttributes(el, model.a ?? {}, true);
        if (model.o) {
          // The marker lives on the element, not in a side map. `opaqueAt` hit-tests the
          // attribute, so a parallel `Map<id, reason>` was written on every opaque node and
          // read by nobody.
          el.setAttribute("data-sky-opaque", model.o);
          el.setAttribute("data-sky-opaque-label", OPAQUE_LABELS[model.o] ?? OPAQUE_LABELS.unknown);
          // No children, by construction: the serializer did not send any, and rendering a
          // placeholder that looked populated would be worse than one that looks empty.
          return el;
        }
        for (const child of model.c ?? []) {
          const built = this.build(child);
          if (built) el.appendChild(built);
        }
        return el;
      }
      default:
        return null;
    }
  }

  private create(model: MirrorNode): Element {
    const name = model.n ?? "div";
    if (model.ns === "svg") return this.doc.createElementNS(SVG_NS, name);
    if (model.ns === "mathml") return this.doc.createElementNS(MATHML_NS, name);
    try {
      return this.doc.createElement(name);
    } catch {
      // A tag name this document will not accept. `<unknown>` renders as an inline box,
      // which is what an unrecognised element does anyway.
      return this.doc.createElement("span");
    }
  }

  private setStyleText(el: Element, css: string): void {
    if (el.tagName === "STYLE") el.textContent = filterCss(css);
  }

  /**
   * @param fresh The element was created moments ago and has no attributes yet, so the removal
   *   pass cannot match anything. True on the snapshot path, where it would otherwise allocate
   *   a throwaway array per element for a loop that cannot run — 5,000 of them on a large page,
   *   at the most latency-sensitive moment in the agent's console.
   */
  private setAttributes(el: Element, attrs: Record<string, string>, fresh = false): void {
    // Remove what is gone, so an attribute the page deleted does not linger.
    if (!fresh) {
      for (const existing of Array.from(el.attributes)) {
        if (existing.name.startsWith("data-sky-")) continue;
        if (!(existing.name in attrs)) el.removeAttribute(existing.name);
      }
    }
    for (const name in attrs) {
      const value = attrs[name] as string;
      // Lower-cased, because `setAttribute` lower-cases HTML attribute names: a
      // case-sensitive check let `ONCLICK` and `HREF` through untouched.
      const lower = name.toLowerCase();
      if (lower.startsWith("on")) continue;
      if (lower === "http-equiv") continue; // never let mirrored content set a policy

      const role = urlRole(lower);
      if (role) {
        const raw = String(value);
        const usable = role === "render" && isFetchable(raw);
        // Kept as a data attribute regardless, so the agent can still read where a link
        // points even when the mirror may not follow it.
        el.setAttribute(`data-sky-${lower.replace(/[^a-z0-9-]/g, "-")}`, usable ? raw : "");
        if (usable) {
          try {
            el.setAttribute(name, raw);
          } catch {
            /* an attribute name this document will not accept */
          }
        } else {
          el.removeAttribute(name);
        }
        continue;
      }
      try {
        el.setAttribute(name, String(value));
      } catch {
        // An attribute name the customer's page holds that this document will not accept.
        // Skipped rather than fatal: one bad attribute must not stop a session.
      }
      if (lower === "value" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        (el as HTMLInputElement).value = String(value);
      }
      if (lower === "checked" && el.tagName === "INPUT") {
        (el as HTMLInputElement).checked = true;
      }
      if (lower === "selected" && el.tagName === "OPTION") {
        (el as HTMLOptionElement).selected = true;
      }
    }
    if (el.tagName === "INPUT" && !("checked" in attrs)) (el as HTMLInputElement).checked = false;
    if (el.tagName === "OPTION" && !("selected" in attrs)) (el as HTMLOptionElement).selected = false;
  }
}

/**
 * Every `url()` and `@import` in mirrored CSS, filtered.
 *
 * The serializer has already resolved them against the stylesheet's own base, so anything
 * still relative here is something it could not resolve and this end must not guess about.
 * `<style>` text was previously rebuilt with no filtering at all, which let a hostile page
 * make the agent's browser fetch an origin of its choosing — the CSP above closes that
 * class, and this closes the instance.
 */
export function filterCss(css: string): string {
  if (!css) return "";
  if (css.indexOf("url(") === -1 && css.indexOf("@import") === -1) return css;
  return rewriteCssUrls(css, (url) => (isFetchable(url) ? url : null));
}

/**
 * Refuse to render into a document that can run scripts.
 *
 * Rule 1 in this file's header is the caller's to keep — `Mirror` is handed a `Document` and
 * does not create the frame — so this is the check that makes it more than a comment. The
 * console is a different application in a different repository, and "the frame is sandboxed"
 * is exactly the kind of invariant that survives review and then dies to a refactor of the
 * component that happens to own the `<iframe>`.
 *
 * **Tested by capability, not by attribute.** Reading `frameElement.sandbox` would be a string
 * comparison against a list that can be spelled several ways, would miss a frame whose sandbox
 * comes from a CSP header, and says nothing at all about a document that is not in a frame.
 * What actually matters is one question: can script *run* in here?
 *
 * **The probe has to be a `<script>` the document runs itself.** Two earlier attempts were
 * wrong in the same way and both are worth recording, because each looked obviously correct:
 * `new view.Function(...)` only *constructs* — a sandbox blocks execution, not construction —
 * and calling the result does not help either, because a same-origin parent may always call
 * into its child. Measured: `new view.Function("return 1")()` returns `1` in a frame sandboxed
 * without `allow-scripts`, in one with it, and in one with no sandbox at all. It distinguishes
 * nothing.
 *
 * What the sandbox actually governs is whether *the document* may run script it contains, which
 * is precisely the threat here — markup from a customer's page executing in the agent's console.
 * So the probe injects a `<script>` and checks whether it ran: `false` when sandboxed, `true`
 * when not, which is the distinction the guard needs and the only one that matched it.
 *
 * Narrow on purpose: it throws only when execution is positively demonstrated, so an
 * inconclusive environment renders rather than failing closed. The message names the fix rather
 * than the symptom.
 */
export function assertSandboxed(doc: Document): void {
  const view = doc.defaultView as (Window & { __skyProbe?: boolean }) | null;
  if (!view) return; // a detached document: nothing can run in it either
  let scriptsRun = false;
  try {
    const probe = doc.createElement("script");
    probe.textContent = "window.__skyProbe = true";
    (doc.body ?? doc.documentElement)?.appendChild(probe);
    scriptsRun = view.__skyProbe === true;
    probe.remove();
    delete view.__skyProbe;
  } catch {
    // A document that will not even accept the probe is not one that will run a page.
    scriptsRun = false;
  }
  if (!scriptsRun) return;
  throw new Error(
    "sky-remote/mirror: refusing to render into a document that can execute scripts. " +
      'The mirror renders untrusted markup from a customer\'s page and must be given a frame ' +
      'created with sandbox="allow-same-origin" — same-origin so nodes can be built, and ' +
      "WITHOUT allow-scripts so nothing in it can run."
  );
}
