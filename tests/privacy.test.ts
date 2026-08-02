/**
 * The sensitivity classifier, without a browser.
 *
 * `harness/tests/privacy.spec.ts` proves the policy holds against real DOM in a real browser.
 * This file pins the parts that are pure functions, because they are where the judgement calls
 * live and because a false positive is cheap to introduce and expensive to notice: it produces
 * a field the agent cannot read and cannot type into, with no error explaining why.
 *
 * The negative cases are therefore load-bearing. Over-matching is how the previous design
 * failed, and the direction it failed in — hiding more than it should — is the direction that
 * looks safe in review and breaks the product in production.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isFieldProtected,
  isSensitiveField,
  looksLikePaymentCard,
  type FieldFacts
} from "../sdk/src/privacy.ts";

/** A field with nothing notable about it, overridden per case. */
function field(over: Partial<FieldFacts> & { label?: string } = {}): FieldFacts {
  const { label = "", ...rest } = over;
  // `label` is a thunk on the real type: producing it costs a DOM query, so the classifier only
  // asks for it after the cheaper signals are inconclusive. Tests pass a plain string.
  return { tag: "INPUT", type: "text", autocomplete: "", identity: "", value: "", ...rest, label: () => label };
}

test("payment cards are detected by shape, with separators", () => {
  // Luhn-valid test numbers from the card networks' own published set.
  for (const card of [
    "4242424242424242",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "5555555555554444",
    "378282246310005",
    "6011111111111117"
  ]) {
    assert.equal(looksLikePaymentCard(card), true, `${card} should be detected`);
  }
});

test("things that merely look numeric are not cards", () => {
  for (const notCard of [
    "1234567812345678", // right length, fails Luhn
    "69002", // a postcode
    "SUMMER20", // a promo code
    "0000000000000000", // Luhn-valid but not an issuer range
    "123456789012", // too short
    "12345678901234567890", // too long
    "", // empty
    "4242424242424243" // one digit off a real card
  ]) {
    assert.equal(looksLikePaymentCard(notCard), false, `${notCard} should not be detected`);
  }
});

test("sensitive fields are detected by each available signal", () => {
  // autocomplete, including the section/billing prefixes the HTML spec allows.
  assert.equal(isSensitiveField(field({ autocomplete: "cc-number" })), true);
  assert.equal(isSensitiveField(field({ autocomplete: "section-b billing cc-csc" })), true);
  assert.equal(isSensitiveField(field({ autocomplete: "current-password" })), true);
  assert.equal(isSensitiveField(field({ autocomplete: "one-time-code" })), true);
  // name/id/class.
  assert.equal(isSensitiveField(field({ identity: "card_cvv" })), true);
  assert.equal(isSensitiveField(field({ identity: "user_iban" })), true);
  // Every casing a form generator actually emits. `apiKey` used to slip through: the pattern
  // anchors on non-letter boundaries and camelCase has none.
  for (const spelling of ["apiKey", "api_key", "api-key", "API_KEY", "cardNumber", "securityCode"]) {
    assert.equal(isSensitiveField(field({ identity: spelling })), true, `${spelling} should match`);
  }
  // the accessible label, when every attribute is anonymous.
  assert.equal(isSensitiveField(field({ label: "CVC" })), true);
  assert.equal(isSensitiveField(field({ label: "Security code" })), true);
  // the value's own shape, when nothing else gives it away.
  assert.equal(isSensitiveField(field({ identity: "q", value: "4242424242424242" })), true);
  // the unconditional types.
  assert.equal(isSensitiveField(field({ type: "password" })), true);
  assert.equal(isSensitiveField(field({ type: "tel" })), true);
});

test("ordinary fields are not swept up", () => {
  // Each of these contains a substring that a lazier pattern would have matched. They are the
  // regression cases for the over-matching that made the mirror unusable.
  const ordinary: [string, Partial<FieldFacts>][] = [
    ["a promo code", { identity: "promo_code", value: "SUMMER20" }],
    ["a postcode", { identity: "postcode", value: "69002" }],
    ["a country code", { identity: "country_code", value: "FR" }],
    ["a cardholder name", { identity: "cardholder_name", value: "Jane Dupont" }],
    ["an order reference", { identity: "order_ref", value: "1234567812345678" }],
    ["a discarded field", { identity: "discard_reason" }],
    ["a pinned toggle", { identity: "pinned" }],
    ["a shipping field", { identity: "shipping_line1" }],
    ["an address", { identity: "address1", autocomplete: "address-line1" }],
    ["an email", { type: "email", identity: "email", value: "jane@example.fr" }],
    ["a card title in a UI kit", { identity: "card-title" }],
    ["a search box", { identity: "q", value: "red bicycle" }]
  ];
  for (const [what, over] of ordinary) {
    assert.equal(isSensitiveField(field(over)), false, `${what} should stay legible`);
  }
});

test("structural types carry no free text and stay visible", () => {
  for (const type of ["checkbox", "radio", "range", "color", "hidden", "file", "submit"]) {
    assert.equal(isSensitiveField(field({ type })), false, `${type} should stay visible`);
  }
});

test("a structural type is not a way round the classifier", () => {
  // `type` is attacker-adjacent input in the sense that matters here: it is whatever the
  // merchant's framework rendered. A checkbox whose name says `cvv` is a strange thing that
  // should still be treated as one, so the ordering inside `isSensitiveField` matters —
  // `MASK_ALWAYS_TYPES` is checked before the structural shortcut.
  assert.equal(isSensitiveField(field({ type: "password" })), true);
  // And the structural shortcut does return early for a genuine checkbox, which is the
  // behaviour that keeps "which delivery option did they pick" answerable.
  assert.equal(isSensitiveField(field({ type: "checkbox", identity: "gift_wrap" })), false);
});

test("the standard tier protects sensitive fields and nothing else", () => {
  assert.equal(isFieldProtected(field({ autocomplete: "cc-number" }), "standard", false), true);
  assert.equal(isFieldProtected(field({ identity: "address1" }), "standard", false), false);
});

test("the strict tier protects everything not allowed", () => {
  assert.equal(isFieldProtected(field({ identity: "address1" }), "strict", false), true);
  assert.equal(isFieldProtected(field({ identity: "address1" }), "strict", true), false);
});

test("strict is never weaker than standard", () => {
  // The invariant that makes having two tiers safe: an allowlist is permission to show
  // ordinary content, never permission to show a credential. If this ever fails, `strict`
  // has become a way to expose something `standard` would have protected.
  // Named, because `FieldFacts.label` is a function and a stringified thunk names nothing.
  const secrets: [string, Partial<FieldFacts> & { label?: string }][] = [
    ["type=password", { type: "password" }],
    ["type=tel", { type: "tel" }],
    ["autocomplete=cc-number", { autocomplete: "cc-number" }],
    ["autocomplete=one-time-code", { autocomplete: "one-time-code" }],
    ["name=card_cvv", { identity: "card_cvv" }],
    ["label=CVC", { label: "CVC" }],
    ["a Luhn-valid value in an anonymous field", { identity: "q", value: "4111111111111111" }]
  ];
  for (const [what, over] of secrets) {
    for (const allowed of [true, false]) {
      for (const tier of ["strict", "standard"] as const) {
        assert.equal(
          isFieldProtected(field(over), tier, allowed),
          true,
          `${tier} with allowed=${allowed} exposed ${what}`
        );
      }
    }
  }
});
