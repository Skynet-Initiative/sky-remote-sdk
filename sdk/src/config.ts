/**
 * Configuration, and the rules it may not break.
 *
 * Everything here can only ever make the SDK show the agent *less*. There is no option
 * that widens what an agent may do, no option that changes the consent wording, and no
 * option that removes the customer's stop control — those are refusals rather than
 * defaults (the integration contract, "what the integrator cannot
 * configure"), and the enforcement is that the levers do not exist rather than that they
 * are documented as unwise.
 *
 * The one thing that *is* a dial rather than a refusal is [`SkyOptions.privacy`], and it is
 * validated rather than coerced: a typo in it must not resolve to "show the agent more".
 */

import { OPT_OUT_SELECTOR, type PrivacyTier } from "./privacy.js";

export type { PrivacyTier } from "./privacy.js";

export interface SkyOptions {
  /** The publishable key, `pk_live_…`. Public by design; it grants nothing. */
  workspace?: string | undefined;
  /**
   * How much of the page the agent may read.
   *
   * `"standard"` (the default) shows the page and protects what
   * [`privacy.ts`](./privacy.ts) classifies as sensitive — card numbers, passwords, CVVs,
   * one-time codes — with no configuration required. `"strict"` is the allowlist tier: the
   * agent reads nothing that `unmask` does not name.
   *
   * Both tiers refuse input into anything they mask, so neither can be talked into letting
   * an agent type a customer's password.
   */
  privacy?: PrivacyTier | undefined;
  /** Selectors whose subtree is shown to the agent in the clear. Only meaningful in
   *  `strict`, where nothing is legible by default; in `standard` the page is already
   *  legible and this widens nothing beyond it. Never overrides the sensitive-field
   *  classifier. */
  unmask?: string[] | undefined;
  /** Selectors whose text and values are masked, in either tier. The blocklist half of the
   *  standard tier: what a merchant names in addition to what we detect. */
  mask?: string[] | undefined;
  /** Selectors never shown at all — the region is inert and unclickable, not merely
   *  bulleted. Applies in every tier and overrides `unmask`. */
  block?: string[] | undefined;
  /** Overridable for local development only; the defaults are what ships. */
  signal?: string | undefined;
  consent?: string | undefined;
  /** BCP-47 tag for the consent surface. Falls back to the page's `<html lang>`, then to
   *  the browser's. */
  locale?: string | undefined;
}

export interface ResolvedConfig {
  workspaceKey: string | null;
  signal: string;
  consent: string;
  privacy: PrivacyTier;
  unmask: string[];
  mask: string[];
  block: string[];
  locale: string | null;
}

/**
 * Where the estate lives.
 *
 * `sdk.` and `consent.` are separate origins deliberately — the browser's own same-origin
 * policy is what stops the in-page bundle reaching inside the consent surface, and a
 * shared origin would hand that boundary away (docs/03 §2a).
 */
export const DEFAULTS = {
  signal: "wss://remote.skynet-initiative.com/signal",
  consent: "https://consent.skynet-initiative.com/"
} as const;

export function initialConfig(): ResolvedConfig {
  return {
    workspaceKey: null,
    signal: DEFAULTS.signal,
    consent: DEFAULTS.consent,
    // The tier a merchant gets when they paste a script tag and read no documentation. It
    // has to be the one that both works and protects the things that matter, because it is
    // the one almost everybody will run. See `privacy.ts` for why this is not `strict`.
    privacy: "standard",
    unmask: [],
    // Not empty: the opt-out markers every comparable honours are on by default, so a
    // merchant who already annotates their sensitive fields for another vendor — or for
    // rrweb — is protected here without configuring us at all.
    mask: [OPT_OUT_SELECTOR],
    block: [],
    locale: null
  };
}

/**
 * Every selector, validated now rather than at first use.
 *
 * D-19: fail closed. A malformed selector stops the stream rather than being skipped,
 * because "skipped" means masking less than the page asked for and saying nothing.
 */
export function compileSelectors(list: readonly string[], what: string): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const sel = String(raw);
    try {
      document.querySelector(sel);
    } catch {
      throw new Error(
        `sky-remote: ${what} selector ${JSON.stringify(sel)} is not valid CSS. ` +
          "Refusing to stream rather than silently masking less than you asked for."
      );
    }
    out.push(sel);
  }
  return out;
}

/**
 * The privacy tier, or a refusal.
 *
 * Unknown values throw rather than falling back. A silent fallback here is a privacy
 * decision made by a typo — `privacy: "strickt"` resolving to `"standard"` would show the
 * agent a page the merchant believed was allowlisted — and it is the same fail-closed
 * argument `compileSelectors` makes one function below.
 */
function readTier(value: string): PrivacyTier {
  if (value === "standard" || value === "strict") return value;
  throw new Error(
    `sky-remote: privacy must be "standard" or "strict", not ${JSON.stringify(value)}. ` +
      "Refusing to stream rather than guessing which one you meant."
  );
}

export function applyOptions(config: ResolvedConfig, options?: SkyOptions): ResolvedConfig {
  if (!options) return config;
  if (options.workspace) config.workspaceKey = String(options.workspace);
  if (options.signal) config.signal = String(options.signal);
  if (options.consent) config.consent = String(options.consent);
  if (options.locale) config.locale = String(options.locale);
  if (options.privacy) config.privacy = readTier(String(options.privacy));
  if (options.unmask) config.unmask = compileSelectors(options.unmask, "unmask");
  // The built-in opt-out markers are a FLOOR the merchant's list is added to, never replaces —
  // but the floor is re-stated here rather than accumulated onto the previous answer.
  //
  // `config.mask.concat(...)` grew the list on every call: the resolved config already held the
  // floor plus whatever the last call added, so `configure({ mask: [".x"] })` three times left
  // `.x` in it three times. `applyOptions` is called on every `configure()`, and again from
  // `requestAssistance()` and `present()` — so an integrator who configures per route, or a
  // React effect that re-runs, pays a duplicate selector per call. Every duplicate is a full
  // `el.matches()` on every element of every `ancestry()` walk, on the path that also runs on
  // every keystroke. Idempotent now: the same options in produce the same config out.
  if (options.mask) {
    config.mask = [OPT_OUT_SELECTOR, ...compileSelectors(options.mask, "mask")];
  }
  if (options.block) config.block = compileSelectors(options.block, "block");
  return config;
}

/**
 * Configuration from the script tag, for the no-build integration.
 *
 * Read from `document.currentScript` at module evaluation, which is the only moment it is
 * defined. An ESM import has no `currentScript`, so this returns nothing and the
 * integrator passes options to `configure()` instead — both paths converge on the same
 * resolved config.
 */
export function readScriptAttributes(): SkyOptions {
  const script = typeof document !== "undefined" ? document.currentScript : null;
  if (!script || !(script instanceof HTMLScriptElement)) return {};
  const data = script.dataset;
  const options: SkyOptions = {};
  if (data.workspace) options.workspace = data.workspace;
  if (data.signal) options.signal = data.signal;
  if (data.consent) options.consent = data.consent;
  if (data.locale) options.locale = data.locale;
  if (data.privacy) options.privacy = data.privacy as PrivacyTier;
  if (data.unmask) options.unmask = splitList(data.unmask);
  if (data.mask) options.mask = splitList(data.mask);
  if (data.block) options.block = splitList(data.block);
  return options;
}

/** `data-unmask="#order, .address"` — comma-separated, because an attribute cannot hold
 *  an array and a selector may not contain a bare comma at the top level. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
