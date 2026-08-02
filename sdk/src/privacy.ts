/**
 * What is sensitive, decided once.
 *
 * ## Why this file exists
 *
 * The first serializer had one rule — *mask everything, the merchant opts out per selector*
 * — and it was the right instinct applied at the wrong altitude. Measured against the S-8
 * corpus on the shipping defaults it produced a mirror in which **100% of visible text was
 * bullets** and **every input was `masked`**, which through the blind-click rule
 * (the trust model §2c) also made every field untypeable. A
 * support agent could not read a heading, a price, a product name or an order reference, and
 * could not type into anything. That is not a privacy control; it is a product that does not
 * work, and a merchant's only escape hatch was `unmask: ["html"]` — which turns the whole
 * policy off in one line. Our own fidelity suite did exactly that.
 *
 * A control nobody can run in production protects nobody. The `unmask: ["html"]` in the test
 * suite was the design telling us so.
 *
 * ## The rule that replaces it
 *
 * **Protect values, not structure.** What identifies a person, drains an account, or grants
 * access is the *value* in a field — a card number, a CVV, a password, an authentication
 * code. What a support agent needs is the *page*: headings, labels, prices, product names,
 * validation errors, and the shape of the form. Those two sets barely intersect, and the old
 * design destroyed the second to protect the first.
 *
 * So: page text and labels are visible; sensitive values are masked and untypeable; and what
 * counts as sensitive is decided **here**, in one place, by a classifier that fires on field
 * type, `autocomplete` token, name/id shape, ARIA labelling, and the shape of the value
 * itself — not by asking the merchant to enumerate their own secrets correctly.
 *
 * ## Two tiers, because the market has two customers
 *
 * Calibrated against the comparables in the prior-art review rather than
 * from first principles, because "be paranoid" is what produced the unusable version:
 *
 *  - **rrweb**'s recording default is `maskInputOptions: { password: true }` — passwords, and
 *    nothing else.
 *  - **Upscope** automatically masks password fields and values that *look like* card
 *    numbers, and shows the rest of the page.
 *  - **Cobrowse.io** ships *two* modes: a standard blocklist ("tell the SDK what must not be
 *    seen") and an opt-in `private-by-default` allowlist for regulated deployments.
 *
 * The instructive part is that nobody's default masks page text, and the one product with an
 * allowlist mode sells it as the strict tier rather than shipping it as the only tier. We had
 * built the strict tier, shipped it as the only tier, and left its allowlist empty.
 *
 * Hence [`PrivacyTier`]:
 *
 *  - `"standard"` — the default. Structure and text visible; everything this file classifies
 *    as sensitive is masked and untypeable. Strictly stronger than every default above,
 *    because the classifier is wider than "password" and does not need merchant help.
 *  - `"strict"` — the previous behaviour, kept and named: nothing is legible unless a
 *    selector allows it. For PCI/CDE deployments and for merchants whose compliance function
 *    wants an allowlist. `MASK_ALWAYS` still applies inside an allowed subtree, so the strict
 *    tier can never be *weaker* than the standard one.
 *
 * ## The invariant that makes this safe to relax
 *
 * Every relaxation here is a relaxation of what the agent may **see**. Nothing in this file
 * widens what the agent may **do**: the answer from [`isFieldProtected`] drives both the
 * mirror and the chokepoint, so anything masked stays untypeable by construction. A change
 * that made a field legible and typeable is one edit in one function, reviewable as such —
 * which is the property the old design's `!inUnmasked(el)` did not have, because it conflated
 * "the merchant did not list this" with "this is a secret".
 */

/** Which posture the SDK is in. Named, so a change of tier is a change of one word. */
export type PrivacyTier = "standard" | "strict";

/**
 * Input types whose value is never shown and never typeable, in any tier, under any
 * configuration.
 *
 * These are refusals rather than defaults (the trust model, refuse
 * list item 6: no "let the agent type the customer's password"). A merchant cannot opt out,
 * which is why the set is small and every entry earns its place:
 *
 *  - `password` — self-evident, and the one thing every comparable also masks.
 *  - `tel` — a phone number is an account-recovery factor and the pivot in a SIM-swap.
 *
 * **`email` was here and has been removed.** It is the single most common thing a support
 * agent legitimately needs to read back — "can you confirm the email on the account?" — and
 * masking it protected almost nothing: the agent is already talking to the customer, usually
 * *about* the account the address identifies. It is now `clear` in the standard tier and
 * masked in the strict tier like any other value, which is the honest treatment. The old
 * behaviour made the corpus assert `"•".repeat("jane@example.fr".length)`, a test that
 * encoded the paranoia rather than a requirement.
 */
const MASK_ALWAYS_TYPES: ReadonlySet<string> = new Set(["password", "tel"]);

/**
 * Field types that carry no free text and are safe to show in either tier.
 *
 * A checkbox's `checked` and a select's chosen option are how a support agent sees which
 * delivery method or which consent box the customer picked. Bulleting them communicated
 * nothing to anyone: `"•"` for a checkbox is not a privacy win, it is a broken widget.
 */
const STRUCTURAL_TYPES: ReadonlySet<string> = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "button",
  "submit",
  "reset",
  "image",
  "hidden",
  "file"
]);

/**
 * `autocomplete` tokens that mean "this is a payment instrument or a secret".
 *
 * This is the highest-quality signal available and it costs nothing to read: the tokens are
 * standardised in the HTML specification, and a merchant who wants their card form to
 * autofill has *already* written them correctly, because the browser rewards it. Detection
 * that rides on something the merchant is independently motivated to get right is worth more
 * than detection that depends on them configuring us.
 *
 * `cc-number`, `cc-csc` and `cc-exp*` are the PCI-relevant fields. `new-password` and
 * `current-password` catch a password field a framework rendered as `type="text"` behind a
 * show/hide toggle — which is common, and which a type-only check misses entirely.
 */
const SENSITIVE_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-name",
  "cc-type",
  "current-password",
  "new-password",
  "one-time-code"
]);

/**
 * Name/id/class fragments that mean the same thing when `autocomplete` is absent.
 *
 * A heuristic, and deliberately a conservative one: every entry is a word that does not
 * appear in a non-sensitive field name in practice. `cvv`, `cvc`, `iban`, `sortcode`, `ssn`,
 * `passport` have no innocent reading. `secret`, `token`, `otp` and `mfa` catch the
 * credential-adjacent fields that neither type nor `autocomplete` will flag.
 *
 * **Not included, on purpose:** `card` alone (matches `cardholder`, `discard`, `card-title`
 * in every CSS framework), `pin` alone (matches `pincode`, `shipping`, `pinned`), and `code`
 * alone (matches `postcode`, `country-code`, `promo-code` — a discount code is something the
 * agent frequently needs to read). Each of those would have produced false positives on
 * ordinary pages, and a false positive here is an invisible field the agent cannot type into,
 * with no error message that explains why. Over-matching is how the old design failed; it is
 * not a safe direction to fail in.
 */
const SENSITIVE_NAME_PATTERN =
  /(?:^|[^a-z])(?:cvv|cvc|csc|cid|iban|bic|swift|sortcode|routing|ssn|sin|nino|passport|taxid|creditcard|cardnumber|cardnum|ccnum|securitycode|passwd|password|pwd|secret|token|apikey|otp|mfa|totp|twofactor|seedphrase|mnemonic|privatekey)(?:[^a-z]|$)/i;

/**
 * The merchant's own opt-out markers, honoured without configuration.
 *
 * Every comparable supports a "do not record this" attribute or class, and integrators reach
 * for the name they already know. Accepting the common spellings costs one selector and
 * removes a migration step for anyone arriving from another vendor — including our own
 * `data-sky-*` for a merchant who wants a name that does not mention a competitor.
 *
 * These *add* protection and can never remove it, so accepting a wide list is safe in the
 * direction that matters.
 */
export const OPT_OUT_SELECTOR = [
  "[data-sky-private]",
  "[data-sky-mask]",
  "[data-private]",
  "[data-no-capture]",
  "[data-nocapture]",
  "[data-sensitive]",
  ".sky-private",
  ".sky-mask",
  ".rr-mask",
  ".rr-block",
  ".fs-mask",
  ".fs-exclude",
  ".ph-no-capture",
  ".sensitive",
  ".private"
].join(",");

/**
 * A value that looks like a payment card, whatever the field is called.
 *
 * The last line of defence, and the one that catches the case no attribute will: a card
 * number typed into a field named `<input name="q">`, or into a generic text input on a
 * checkout a framework generated. Upscope does this and it is right to.
 *
 * Luhn is what makes it a *detector* rather than a "13-to-19 digits" match that would eat
 * order numbers, tracking references and phone numbers. A random digit string passes Luhn
 * about one time in ten, so Luhn alone is not sufficient either — but combined with the
 * length window and a leading digit in the range the card networks actually issue from, the
 * false-positive rate on non-card data is low enough to be worth the protection.
 *
 * Separators are stripped first, because a customer types `4111 1111 1111 1111`.
 */
export function looksLikePaymentCard(value: string): boolean {
  // Before allocating anything. 19 digits plus at most four separators is the longest a card can
  // be, and this runs on every ordinary field value — a long note or address should not pay for a
  // full strip-and-scan to discover it is not 13-to-19 digits.
  if (value.length < 13 || value.length > 23) return false;
  const digits = value.replace(/[\s-]/g, "");
  if (!/^[0-9]{13,19}$/.test(digits)) return false;
  // Visa 4, Mastercard 5, Amex 3, Discover/others 6. A 13-to-19 digit string starting 0, 7,
  // 8 or 9 is not a card and is very likely an internal reference.
  if (!/^[3-6]/.test(digits)) return false;
  return luhn(digits);
}

/** The card-number check digit. Standard, and worth having rather than approximating. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Does this name, in any of the casings a form actually uses, name something sensitive?
 *
 * `apiKey`, `api_key`, `api-key` and `API KEY` are the same field with four spellings, and a
 * pattern anchored on non-letter boundaries catches three of them. camelCase is split on the
 * case change first — `apiKey` becomes `api key` — so the boundary the pattern needs is
 * present however the merchant's framework generated the attribute.
 *
 * The boundary itself is kept rather than dropped: matching bare substrings is what would turn
 * `postcode` into a secret.
 */
function matchesSensitiveName(name: string): boolean {
  if (!name) return false;
  // One canonical form: camelCase split, then every separator reduced to a single space. The
  // pattern is anchored on non-letter boundaries, so `cardNumber`, `card_cvv`, `card-cvv` and
  // `card.cvv` all reach it as words. Tested against it a second time with the spaces removed,
  // because the multi-word entries (`apikey`, `cardnumber`, `securitycode`) are written collapsed.
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
  return SENSITIVE_NAME_PATTERN.test(words) || SENSITIVE_NAME_PATTERN.test(words.replace(/ /g, ""));
}

/** Everything the classifier needs to know about the element, without reaching for the DOM
 *  twice. `matches` is injected so this module never has to know about `config`. */
export interface FieldFacts {
  tag: string;
  type: string;
  autocomplete: string;
  /** `name`, `id`, and `class` joined — the haystack for the name heuristic. */
  identity: string;
  /**
   * The element's accessible label, when the page gave it one. A field labelled "Card number" is
   * a card number even if every attribute on it is anonymous.
   *
   * A function, not a string: producing it costs a `label[for=…]` document query and an ancestor
   * walk, and it is consulted only after `type`, `autocomplete` and the name have all come back
   * inconclusive. Eagerly building it made every checkbox, hidden input and submit button pay for
   * a string nothing would read — twice per snapshot, and again on every keystroke.
   */
  label: () => string;
  value: string;
}

/**
 * Is this field's value sensitive?
 *
 * Ordered cheapest and most authoritative first. Every branch is a positive reason to
 * protect; there is no branch that protects because a merchant failed to list something,
 * which is the whole difference from the design this replaces.
 */
export function isSensitiveField(f: FieldFacts): boolean {
  if (MASK_ALWAYS_TYPES.has(f.type)) return true;
  if (STRUCTURAL_TYPES.has(f.type)) return false;

  // `autocomplete` may carry section and billing/shipping prefixes: `section-a billing
  // cc-number`. The meaningful token is the last one.
  const tokens = f.autocomplete.toLowerCase().trim().split(/\s+/);
  const token = tokens[tokens.length - 1] ?? "";
  if (SENSITIVE_AUTOCOMPLETE.has(token)) return true;

  if (matchesSensitiveName(f.identity)) return true;
  if (matchesSensitiveName(f.label())) return true;

  // The value itself, last: an unlabelled field holding something card-shaped.
  if (looksLikePaymentCard(f.value)) return true;

  return false;
}

/**
 * What may be done with this field, in this tier.
 *
 * The one function both the serializer and the chokepoint call.
 *
 * In `strict`, a field is protected unless the merchant allowed its subtree — the previous
 * behaviour, now scoped to the tier that asked for it. In `standard`, a field is protected
 * when the classifier says so. `MASK_ALWAYS_TYPES` is checked inside `isSensitiveField`, so
 * `allowed` can never expose a password: strict is never weaker than standard.
 */
export function isFieldProtected(f: FieldFacts, tier: PrivacyTier, allowed: boolean): boolean {
  if (isSensitiveField(f)) return true;
  // The same rule text uses, asked of the same function. It was written out again here in
  // inverted polarity — `tier === "strict" && !allowed` — which is one predicate with two places
  // to drift.
  return !textIsLegible(tier, allowed);
}

/**
 * Should text in this tier be legible?
 *
 * Text is not a field: it carries no value the agent can submit and no credential. In
 * `standard` it is legible, which is the entire fix — a support agent can read the page they
 * were called about. A sensitive *region* is still masked, but that decision is made by
 * selector on the element, not by bulleting every character in the document.
 */
export function textIsLegible(tier: PrivacyTier, allowed: boolean): boolean {
  return tier === "standard" || allowed;
}
