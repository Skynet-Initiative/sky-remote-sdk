/**
 * The privacy contract, in both tiers.
 *
 * Two claims, and the suite fails if either breaks:
 *
 *  1. **The page is readable.** Under the shipping defaults a support agent can read the
 *     headings, labels, prices and ordinary field values of the page they were called about.
 *     This is the regression that motivated the rework: the previous default bulleted 100% of
 *     visible text and marked every input opaque, so the fidelity suite could only pass by
 *     passing `unmask: ["html"]` — turning the whole policy off.
 *
 *  2. **Sensitive values are protected, and protection means untypeable.** Card numbers,
 *     CVVs, passwords, one-time codes and IBANs are bulleted in the mirror *and* refused by
 *     the input chokepoint, detected without merchant configuration. The second half is the
 *     one that matters most and is easiest to lose: a field the agent cannot read but can
 *     type into is the blind-click problem
 *     (the trust model §2c) with a form attached.
 *
 * The negative cases carry equal weight. A promo code, a postcode, an order reference and a
 * cardholder's name must stay legible, because an over-eager classifier reintroduces exactly
 * the unusable product this replaced — and does it invisibly, one field at a time.
 */

import { expect, test, type Page } from "@playwright/test";
import type { MirrorNode } from "../../protocol/src/index.js";
import { loadProbe } from "./support.js";


interface Probed {
  value?: string;
  text: string;
  opaque?: string;
}

/** Every `data-probe` node in the snapshot, by name. */
async function probes(page: Page): Promise<Record<string, Probed>> {
  return page.evaluate(() => {
    const snapshot = window.__sky.snapshot();
    const found: Record<string, { value?: string; text: string; opaque?: string }> = {};
    const textOf = (n: MirrorNode): string => {
      let out = n.t === "tx" ? (n.v ?? "") : "";
      for (const c of n.c ?? []) out += textOf(c);
      return out;
    };
    const walk = (n: MirrorNode): void => {
      const name = n.a?.["data-probe"];
      if (name) {
        found[name] = {
          value: n.a?.["value"],
          text: textOf(n).trim(),
          opaque: n.o
        };
      }
      for (const c of n.c ?? []) walk(c);
    };
    walk(snapshot.root);
    return found;
  });
}

/**
 * A fully masked string.
 *
 * Whitespace survives masking on purpose — `maskText` replaces `\S` only — so a card typed as
 * `4242 4242 4242 4242` masks to `•••• •••• •••• ••••`. That preserves the field's shape
 * without preserving its content, which is what lets an agent see that the customer is typing.
 * The assertion has to allow it; requiring `/^•*$/` would be asserting a bug.
 */
const BULLET = /^[•\s]*$/;

/** Every text node in the snapshot, concatenated. Defined once and evaluated in the page. */
async function snapshotText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const textOf = (n: MirrorNode): string => {
      let out = n.t === "tx" ? (n.v ?? "") : "";
      for (const c of n.c ?? []) out += textOf(c);
      return out;
    };
    return textOf(window.__sky.snapshot().root);
  });
}

/** The fields that must never be legible, and why each is detected. */
const SENSITIVE = [
  "cc-by-autocomplete",
  "cvv-by-prefixed-autocomplete",
  "cvv-by-name",
  "cvv-by-label",
  "cc-by-value",
  "password-as-text",
  "password-type",
  "otp",
  "iban",
  "opt-out-class"
];

/** The fields that must stay legible, because masking them is what broke the product. */
const ORDINARY: Record<string, string> = {
  promo: "SUMMER20",
  postcode: "69002",
  "order-ref": "1234567812345678",
  cardholder: "Jane Dupont",
  address: "14 rue de la Ré",
  email: "jane@example.fr",
  note: "Leave with the concierge"
};

test.describe("the standard tier", () => {
  test("the page a support agent was called about is readable", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    const p = await probes(page);

    // The regression in one assertion: real words, not bullets.
    expect(p["heading"]!.text).toBe("Checkout");
    expect(p["blurb"]!.text).toBe("Order #4417 — two items, shipping to Lyon.");
    expect(p["blurb"]!.text).not.toMatch(/•/);
  });

  test("ordinary field values stay legible", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    const p = await probes(page);
    for (const [probe, expected] of Object.entries(ORDINARY)) {
      expect(p[probe]!.value ?? p[probe]!.text, `${probe} should be legible`).toBe(expected);
    }
  });

  test("ordinary fields are typeable, so control mode works at all", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    // Every input was opaque before the rework, so this was false for all of them and a
    // control-granted agent could not fill in a single field.
    for (const id of ["#g1", "#g4", "#g5", "#g6", "#g9"]) {
      const refusal = await page.evaluate((s) => window.__sky.typeableInto(s), id);
      expect(refusal, `${id} should accept typing`).toBeNull();
    }
  });

  test("sensitive values are masked, detected with no configuration", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    const p = await probes(page);
    for (const probe of SENSITIVE) {
      const value = p[probe]!.value ?? "";
      expect(value, `${probe} must not ship in the clear`).toMatch(BULLET);
      // Length survives so the agent can see that the customer is typing, and how much.
      expect(value.length, `${probe} should keep its shape`).toBeGreaterThan(0);
    }
  });

  test("a masked field is also untypeable — masking and the chokepoint agree", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    // The half that matters most: if we cannot show it, we cannot touch it.
    for (const id of ["#f1", "#f2", "#f3", "#f4", "#f5", "#f6", "#f7", "#f8", "#f9", "#f10"]) {
      const refusal = await page.evaluate((s) => window.__sky.typeableInto(s), id);
      expect(refusal, `${id} must refuse input`).toBe("masked");
    }
  });

  test("labels stay readable on protected fields", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    // A field whose value is hidden still has to announce what it is, or the agent cannot
    // tell the customer which box to fill in. The label text belongs to the wrapping
    // `<label>`, not to the input, so this reads the whole fieldset's text.
    const legend = await snapshotText(page);
    expect(legend).toContain("CVC");
    expect(legend).toContain("Card number");
    expect(legend).toContain("Security code");
  });

  test("structural field state survives", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    const p = await probes(page);
    // Bulleting a checkbox communicates nothing to anyone; it is a broken widget.
    expect(p["checkbox"]!.opaque).toBeUndefined();
    expect(p["select"]!.opaque).toBeUndefined();
    // …and an ordinary select's options stay readable, which is the whole point of the
    // structural carve-out: "which delivery method did they pick" has to be answerable.
    expect(p["select"]!.text).toContain("Express");
  });

  /**
   * A protected `<select>` keeps its options off the wire.
   *
   * The one shape a corpus of `<input>`s cannot catch. Every other field holds its value in a
   * property, which `attributes()` masks; a `<select>` holds its values as `<option>` **text
   * children**, and the serializer used to mark the select `o: "masked"` and then walk those
   * children anyway. The console drops an opaque node's children when it rebuilds, so nothing
   * was visibly wrong — the card list was on the wire and in any frame log, and no fidelity
   * assertion could see it.
   *
   * Asserted on the snapshot rather than on the render for exactly that reason.
   */
  test("a protected select does not ship its options", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    const p = await probes(page);
    expect(p["card-select"]!.opaque, "the select must be marked protected").toBe("masked");
    expect(p["card-select"]!.text, "the option text must not be on the wire").not.toContain("Visa");
    expect(p["card-select"]!.text).not.toContain("Amex");
    expect(p["card-select"]!.text).not.toContain("4242");
  });

  test("a protected select is untypeable, like every other protected field", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html");
    const refusal = await page.evaluate((s) => window.__sky.typeableInto(s), "#f11");
    expect(refusal).toBe("masked");
  });
});

test.describe("the strict tier", () => {
  test("nothing is legible without an allowlist", async ({ page }) => {
    await loadProbe(page, "07-sensitive-fields.html", { privacy: "strict" });
    const p = await probes(page);
    expect(p["heading"]!.text).toMatch(BULLET);
    expect(p["promo"]!.value).toMatch(BULLET);
    expect(p["address"]!.value).toMatch(BULLET);
  });

  test("an allowlisted subtree is legible, and sensitive fields inside it are not", async ({
    page
  }) => {
    await loadProbe(page, "07-sensitive-fields.html", { privacy: "strict", unmask: ["body"] });
    const p = await probes(page);

    expect(p["promo"]!.value).toBe("SUMMER20");
    // The invariant that makes strict safe to have: it can never be weaker than standard.
    // An allowlist covering the whole body still does not expose a card number.
    for (const probe of SENSITIVE) {
      expect(p[probe]!.value ?? "", `${probe} survives an allowlist`).toMatch(BULLET);
    }
  });
});

test("a bad privacy tier refuses rather than guessing", async ({ page }) => {
  await loadProbe(page, "07-sensitive-fields.html");
  // A typo must not resolve to "show the agent more".
  const threw = await page.evaluate(() => {
    try {
      window.__sky.applyOptions({ privacy: "strickt" as "strict" });
      return null;
    } catch (e) {
      return String((e as Error).message);
    }
  });
  expect(threw).toContain('must be "standard" or "strict"');
});
