/**
 * One URL policy, shared by the end that writes URLs and the end that renders them.
 *
 * Two ends held two different opinions before this file and both were wrong in the same
 * change: the serializer sent whatever the attribute said — so a relative `src="/logo.png"`
 * arrived meaningless — and the rebuilder treated every URL-bearing attribute as a
 * request-forgery risk and moved all of them to `data-sky-*`, which is why a
 * `<link rel="stylesheet">` never got an `href` and no stylesheet ever loaded.
 *
 * The rule that replaces both:
 *
 *  - **The serializer absolutizes.** Every URL leaves the customer's page resolved against
 *    their own base, so nothing is ever resolved against the console's origin.
 *  - **The rebuilder classifies.** An attribute is either something the mirror may fetch to
 *    render the page, or something the agent may only read. Nothing is dropped silently.
 *
 * What the mirror may fetch is bounded a second time by a `<meta>` CSP written into the
 * mirror document, so this list being wrong is not on its own sufficient. Attribute names
 * are matched **lower-cased**: `setAttribute` lower-cases HTML attribute names, so a
 * case-sensitive filter here would let `SRC` or `HREF` through untouched.
 */

/** Schemes the mirror is allowed to fetch. `data:` is images and fonts only. */
const FETCHABLE = /^https?:$/i;

export type UrlRole =
  /** The mirror may load it: it is a picture, a font or a stylesheet. */
  | "render"
  /** The agent may read it; the mirror must never follow it. */
  | "inert";

/**
 * Which URL-bearing attributes exist, and what the mirror may do with each.
 *
 * `a[href]` is `render` and it is the one entry worth arguing about. Nothing in the mirror
 * can navigate — the iframe is sandboxed without `allow-top-navigation` and a transparent
 * overlay swallows every event before it reaches the document — and `a:link`, `a:visited`
 * and `a[href]` selectors are a visible part of how a page looks. Stripping it made every
 * link on every mirrored page render as unstyled text.
 */
export const URL_ATTRIBUTES: Record<string, UrlRole> = {
  src: "render",
  srcset: "render",
  poster: "render",
  background: "render",
  "xlink:href": "render",
  href: "render",
  action: "inert",
  formaction: "inert",
  data: "inert",
  cite: "inert",
  longdesc: "inert",
  ping: "inert",
  usemap: "inert",
  manifest: "inert"
};

export function urlRole(attribute: string): UrlRole | null {
  return URL_ATTRIBUTES[attribute.toLowerCase()] ?? null;
}

/**
 * Resolve one URL against a base, or nothing.
 *
 * `javascript:` cannot execute in the mirror — scripts are off — but resolving it would
 * still put an executable string somewhere a future change could follow, so it does not
 * survive. `blob:` and `filesystem:` are origin-bound and meaningless anywhere but the
 * page that made them.
 */
export function absolutize(value: string, base: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Anchors and empty fragments resolve to the page itself and carry no information.
  if (trimmed.startsWith("#")) return trimmed;
  if (/^data:/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed, base);
    if (!FETCHABLE.test(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** `srcset` is a comma-separated list of `url descriptor` pairs, and every url in it needs
 *  the same treatment as a lone `src`. */
export function absolutizeSrcset(value: string, base: string): string | null {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const space = part.search(/\s/);
    const url = space === -1 ? part : part.slice(0, space);
    const descriptor = space === -1 ? "" : part.slice(space).trim();
    const absolute = absolutize(url, base);
    if (!absolute) continue;
    out.push(descriptor ? `${absolute} ${descriptor}` : absolute);
  }
  return out.length ? out.join(", ") : null;
}

/** Is this a URL the mirror may fetch? Applied on the console side, after the serializer
 *  has already resolved it — so anything still relative is something we failed to resolve
 *  and must not guess about. */
export function isFetchable(value: string): boolean {
  const trimmed = value.trim();
  if (/^data:(image\/|font\/|application\/font)/i.test(trimmed)) return true;
  try {
    return FETCHABLE.test(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

const CSS_URL = /url\(\s*(?:(['"])([\s\S]*?)\1|([^)'"\s][^)]*?))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*(?:(['"])([\s\S]*?)\1|([^)'"\s][^)]*?))\s*\)|(['"])([\s\S]*?)\4)/gi;

function quote(url: string): string {
  return `url("${url.replace(/["\\]/g, "\\$&")}")`;
}

/**
 * Rewrite every `url()` and `@import` in a stylesheet through one function.
 *
 * Used twice with two different functions: the serializer resolves them against the
 * sheet's own href, and the console drops the ones it may not fetch. A relative
 * `url(../img/x.png)` inside a stylesheet loaded from `/assets/css/site.css` resolves
 * against **the stylesheet**, not against the document — getting that wrong is how a page
 * mirrors with every background image missing and no error anywhere.
 */
export function rewriteCssUrls(css: string, map: (url: string) => string | null): string {
  const replaced = css.replace(CSS_URL, (whole, _q, quoted, bare) => {
    const original = (quoted ?? bare ?? "").trim();
    if (!original) return whole;
    const next = map(original);
    return next === null ? "url(about:blank)" : quote(next);
  });
  return replaced.replace(CSS_IMPORT, (whole, _q1, quoted, bare, _q2, plain) => {
    const original = (quoted ?? bare ?? plain ?? "").trim();
    if (!original) return whole;
    const next = map(original);
    if (next === null) return "@import url(about:blank)";
    // Preserve any media query that followed the url.
    const rest = whole.slice(whole.indexOf(original) + original.length).replace(/^['")\s]+/, "");
    return `@import ${quote(next)}${rest ? " " + rest : ""}`;
  });
}
