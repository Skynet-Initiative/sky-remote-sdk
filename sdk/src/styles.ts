/**
 * Stylesheet capture — the half of fidelity a DOM walk does not reach.
 *
 * Phase 2 mirrored the customer's page as raw unstyled HTML. Three separate causes, and
 * only the first of them is a DOM problem:
 *
 *  1. A `<link rel="stylesheet">` arrived at the console with its `href` stripped, so no
 *     stylesheet ever loaded. Fixed in the shared URL policy.
 *  2. A CSS-in-JS runtime builds its rules with `insertRule`, which leaves a `<style>`
 *     element whose **text node is empty**. Serializing the text node therefore captures
 *     nothing at all, and that is most of a modern application's styling.
 *  3. `document.adoptedStyleSheets` holds constructed stylesheets that appear in no
 *     element. A serializer that only walks the DOM misses every one.
 *
 * So styling is read from the **CSSOM**, not from the DOM: `element.sheet.cssRules` is
 * what the browser actually applied, whatever put it there. Every `url()` and `@import` is
 * resolved against the sheet's own href on the way out, because a relative
 * `url(../img/x.png)` in `/assets/css/site.css` resolves against the stylesheet and not
 * against the document — and the console must never resolve anything against its own
 * origin.
 */

import { absolutize, rewriteCssUrls } from "../../protocol/src/index.js";

/**
 * The point past which a single stylesheet is referenced rather than inlined.
 *
 * A development build of a utility-first framework can be several megabytes of CSS, and
 * the engine closes a connection carrying a mirror frame over 4 MiB rather than truncating
 * it. Falling back to the `href` costs a fetch from the agent's browser and keeps the
 * session; inlining it unconditionally would cost the session.
 */
const MAX_INLINE_SHEET = 512 * 1024;

/**
 * Serialize one stylesheet, or nothing.
 *
 * Returns `null` for a sheet whose rules cannot be read — a cross-origin stylesheet served
 * without CORS headers, which is most third-party CSS. That is not a failure to handle
 * quietly: the caller falls back to referencing it by href so the page still renders.
 */
export function readSheet(sheet: CSSStyleSheet, documentBase: string, depth = 0): string | null {
  // `@import` chains are finite in practice and unbounded in principle.
  if (depth > 8) return null;
  let rules: CSSRuleList;
  try {
    // Throws `SecurityError` on a cross-origin sheet without `Access-Control-Allow-Origin`.
    rules = sheet.cssRules;
  } catch {
    return null;
  }
  const base = sheet.href || documentBase;
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    let text: string;
    if (isImportRule(rule)) {
      // Inline the imported sheet in place rather than leaving an `@import` the console
      // would have to resolve and fetch for itself.
      const imported = rule.styleSheet ? readSheet(rule.styleSheet, base, depth + 1) : null;
      if (imported !== null) {
        text = rule.media && rule.media.mediaText ? `@media ${rule.media.mediaText}{${imported}}` : imported;
      } else {
        const href = absolutize(rule.href || "", base);
        text = href ? `@import url("${href}")${rule.media?.mediaText ? " " + rule.media.mediaText : ""};` : "";
      }
    } else {
      text = ruleText(rule, base);
    }
    if (!text) continue;
    size += text.length;
    if (size > MAX_INLINE_SHEET) return null;
    out.push(text);
  }
  return out.join("\n");
}

function isImportRule(rule: CSSRule): rule is CSSImportRule {
  // `CSSImportRule` is not defined in every environment this file is type-checked in, so
  // the numeric type is the portable test. 3 is `IMPORT_RULE`.
  return rule.type === 3 && "styleSheet" in rule;
}

function ruleText(rule: CSSRule, base: string): string {
  let text: string;
  try {
    text = rule.cssText;
  } catch {
    return "";
  }
  if (!text || text.indexOf("url(") === -1) return text;
  return rewriteCssUrls(text, (url) => absolutize(url, base));
}

/**
 * The stylesheet text for one element, from the CSSOM where possible.
 *
 * For `<style>` this is the applied rules rather than the element's text, so
 * `insertRule` output is captured. For `<link rel="stylesheet">` it is the loaded sheet.
 * `null` means "the console should reference this by href instead".
 */
export function captureElementStyles(el: Element, documentBase: string): string | null {
  const sheet = (el as HTMLStyleElement | HTMLLinkElement).sheet;
  if (!sheet) {
    // A `<style>` the browser has not parsed yet — inside a `<template>`, or with an
    // unsupported `type`. Its text is the best available answer.
    if (el.tagName === "STYLE") {
      const raw = el.textContent || "";
      return raw ? rewriteCssUrls(raw, (url) => absolutize(url, documentBase)) : "";
    }
    return null;
  }
  return readSheet(sheet as CSSStyleSheet, documentBase);
}

/**
 * `document.adoptedStyleSheets`, serialized.
 *
 * Adopted sheets are applied by reference and belong to no element, so they carry no node
 * id and cannot be mutated incrementally. They are re-read on every snapshot, which is the
 * honest granularity: a design system's constructed sheets are built once at start-up and
 * a page that rebuilt them per frame would be pathological.
 */
export function captureAdopted(doc: Document): string[] {
  const adopted = (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets;
  if (!adopted || !adopted.length) return [];
  const out: string[] = [];
  for (const sheet of adopted) {
    const text = readSheet(sheet, doc.baseURI);
    if (text) out.push(text);
  }
  return out;
}

/** Does this element carry a stylesheet the mirror needs? */
export function isStyleBearing(el: Element): boolean {
  if (el.tagName === "STYLE") return true;
  if (el.tagName !== "LINK") return false;
  const rel = (el.getAttribute("rel") || "").toLowerCase();
  return rel.split(/\s+/).includes("stylesheet");
}
