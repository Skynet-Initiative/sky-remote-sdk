/**
 * Theming the consent surface, without handing anyone a lever on consent.
 *
 * A consent panel that looks nothing like the site it appears on is a panel customers
 * distrust, and distrust of a real dialog is its own failure mode — it teaches people that
 * an out-of-place box asking for permission is normal. So the surface is themeable.
 *
 * ## Why this is a token set and not a stylesheet
 *
 * **No CSS crosses this boundary in either direction.** CSS is a language: it can move
 * things, hide things, invert contrast, reorder a flex container so "Allow" sits where
 * "Not now" was, shrink a control below a fingertip, and reach the network through
 * `url()`. A merchant cannot be given a language and then asked not to use most of it.
 *
 * What they get instead is four named values with types, ranges and derived companions,
 * validated **inside the frame** at render time. The dashboard validates the same way with
 * the same function so an operator sees the rejection when they save rather than when a
 * customer does — but the frame's copy is the one that binds, because the dashboard's
 * answer arrives over a wire the frame does not trust.
 *
 * ## What is deliberately not themeable, and why each one
 *
 * | Not themeable | Because |
 * | --- | --- |
 * | The wording | Refuse-list item 8. A merchant who can author consent text will author text that produces consent. |
 * | The layout, and the order of the two answers | "Allow" styled as the only affordance and "Not now" hidden in the corner is the dark pattern this product exists to not be. |
 * | Control sizes | 44px is the floor for a tappable target, and Allow and Stop are the two most consequential buttons in the product. |
 * | The Stop control's colour | It is semantic. A stop control in the brand's own calm blue is a stop control people do not find. |
 * | The origin line | The one fact the customer can check against their address bar. |
 * | Anything about visibility | Opacity, size, position and stacking are the clickjacking surface. |
 * | Web fonts | See `sanitizeFontStack`. This one is not a judgement call. |
 */

export interface ConsentTheme {
  /** The primary action's colour. Hex or `rgb()`. The label colour on it is derived, not
   *  configured, and a colour too close to the card gets a derived border. */
  accent?: string | null;
  /** Corner radius in px, clamped. A merchant with square corners should get square
   *  corners; nobody needs a 400px radius. */
  radius?: number | null;
  /** A font stack of families **already on the device**. Never a web font. */
  font?: string | null;
  /** Force light or dark rather than following the customer's system preference. A dark
   *  site with a blinding white panel is most of the "it looks odd" complaint. */
  scheme?: "light" | "dark" | "auto" | null;
}

export interface ResolvedTheme {
  accent: string | null;
  /** Chosen, never configured: whichever of black or white the accent can carry. A
   *  merchant who could set the label colour could set it to their own background. */
  accentInk: string | null;
  /** A border for the primary button, set only when the accent is too close to the card
   *  behind it to be findable on its own. Derived from the accent, so it cannot be used to
   *  introduce a colour of its own. */
  accentEdge: string | null;
  radius: number | null;
  font: string | null;
  scheme: "light" | "dark" | "auto";
  /** Every token that was refused, and why. Surfaced in the dashboard so an operator sees
   *  "your brand colour does not have enough contrast for text on it" rather than watching
   *  their setting silently not apply. */
  rejected: { token: string; reason: string }[];
}

const RADIUS_MAX = 24;

/**
 * Below this the primary button is given a visible edge.
 *
 * NOT a rejection threshold, and the difference is the whole design. A pale yellow is a
 * real brand colour; refusing it would push a merchant back to a panel that looks nothing
 * like their site, which is the problem theming exists to solve. What must hold is that the
 * button is *findable*, and a border in a darker shade of the merchant's own colour buys
 * that without refusing anything.
 *
 * The label's readability needs no threshold at all, and it took a failing test to see why:
 * the ink is CHOSEN — whichever of black or white the accent supports — and with a free
 * choice between the two, every possible colour clears 4.5:1 (the worst case, around
 * L = 0.18, still reaches 4.58:1). A "minimum text contrast" check here would have been
 * dead code that read like a safeguard.
 */
const EDGE_BELOW_CONTRAST = 2.2;

/** The two card backgrounds the accent is judged against. Kept here rather than read from
 *  the DOM so the dashboard can give the same verdict without rendering anything. */
const SURFACE_LIGHT = [255, 255, 255] as const;
const SURFACE_DARK = [22, 27, 33] as const;

type Rgb = [number, number, number];

/**
 * Parse a colour, or nothing.
 *
 * Three notations, all of them opaque sRGB literals. No `var()`, no `color-mix()`, no
 * named colours, no functions of any kind — the point of a parser this narrow is that
 * whatever comes out the other side is three numbers, and three numbers cannot carry a
 * `url()` into a stylesheet.
 */
export function parseColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1]!;
    const pairs =
      digits.length === 3 ? [...digits].map((d) => d + d) : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
    return pairs.map((p) => parseInt(p, 16)) as Rgb;
  }

  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*\)$/.exec(text);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map((p) => Number(p));
    if (parts.some((n) => n > 255)) return null;
    return parts as Rgb;
  }

  return null;
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

function toCss([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/** Mix `from` toward `to`. Used only to derive a border from an accent the merchant
 *  already supplied, so nothing here introduces a colour they did not choose. */
function blend(from: Rgb, to: Rgb, amount: number): Rgb {
  return from.map((c, i) => Math.round(c + (to[i]! - c) * amount)) as Rgb;
}

/**
 * A font stack of families the device already has.
 *
 * **Web fonts are refused, and this is not a matter of taste.** A font file controls the
 * mapping from characters to glyphs, so a hostile one can render "see this page and click
 * and type on it as you" as "see this page" while the DOM, the digest and the audit record
 * all say the longer sentence. The customer would be signing something they could not have
 * read. There is no amount of validation on our side that catches it, because the
 * substitution happens after every check we could run.
 *
 * That also means the frame's `default-src 'none'` needs no `font-src` opened, and a
 * merchant's font never fails to load in front of a consent decision.
 */
export function sanitizeFontStack(value: string): string | null {
  const families = value.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
  if (!families.length || families.length > 6) return null;
  const safe: string[] = [];
  for (const family of families) {
    if (!family || family.length > 40) return null;
    // Letters, digits, spaces and hyphens. A family name is an identifier, and anything
    // that is not one is someone trying to close a declaration and open another.
    if (!/^[a-z0-9 _-]+$/i.test(family)) return null;
    safe.push(/\s/.test(family) ? `"${family}"` : family);
  }
  return safe.join(", ");
}

/**
 * Validate a theme, keeping what is safe and naming what is not.
 *
 * Never throws and never returns a partially applied token: a rejected value falls back to
 * the default, so the worst outcome of a bad theme is the panel looking like ours.
 */
export function resolveTheme(theme: ConsentTheme | null | undefined): ResolvedTheme {
  const rejected: ResolvedTheme["rejected"] = [];
  const out: ResolvedTheme = {
    accent: null,
    accentInk: null,
    accentEdge: null,
    radius: null,
    font: null,
    scheme: "auto",
    rejected
  };
  if (!theme) return out;

  if (theme.scheme === "light" || theme.scheme === "dark" || theme.scheme === "auto") {
    out.scheme = theme.scheme;
  } else if (theme.scheme != null) {
    rejected.push({ token: "scheme", reason: "must be light, dark or auto" });
  }

  if (theme.accent != null && theme.accent !== "") {
    const rgb = parseColor(String(theme.accent));
    if (!rgb) {
      rejected.push({
        token: "accent",
        reason: "must be a hex or rgb() colour — no variables, gradients or functions"
      });
    } else {
      const onWhite = contrast(rgb, [255, 255, 255]);
      const onBlack = contrast(rgb, [0, 0, 0]);
      const ink: Rgb = onWhite >= onBlack ? [255, 255, 255] : [0, 0, 0];
      out.accent = toCss(rgb);
      out.accentInk = toCss(ink);

      // Findable against the card it sits on, in whichever scheme it will appear in. A
      // merchant's white-on-white or near-black-on-black gets an edge rather than a
      // refusal — and the edge is derived from their own colour, so this cannot be a way
      // to smuggle a second colour in.
      const surfaces: Rgb[] =
        out.scheme === "dark"
          ? [SURFACE_DARK as unknown as Rgb]
          : out.scheme === "light"
            ? [SURFACE_LIGHT as unknown as Rgb]
            : [SURFACE_LIGHT as unknown as Rgb, SURFACE_DARK as unknown as Rgb];
      if (surfaces.some((surface) => contrast(rgb, surface) < EDGE_BELOW_CONTRAST)) {
        out.accentEdge = toCss(blend(rgb, ink, 0.35));
      }
    }
  }

  if (theme.radius != null) {
    const n = Number(theme.radius);
    if (!Number.isFinite(n) || n < 0) {
      rejected.push({ token: "radius", reason: "must be a number of pixels, 0 or more" });
    } else {
      out.radius = Math.min(Math.round(n), RADIUS_MAX);
    }
  }

  if (theme.font != null && theme.font !== "") {
    const stack = sanitizeFontStack(String(theme.font));
    if (!stack) {
      rejected.push({
        token: "font",
        reason:
          "must be a list of font family names already installed on the device. " +
          "Web fonts are refused: a font file controls which glyph a character draws, so a " +
          "hostile one could render different words from the ones being signed"
      });
    } else {
      out.font = stack;
    }
  }

  return out;
}
