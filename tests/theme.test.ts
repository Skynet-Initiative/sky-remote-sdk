/**
 * What a merchant may change about the consent panel, and what they may not.
 *
 * A themeable consent dialog is a good idea and a dangerous one, and the difference is
 * entirely in whether "customizable" is a token set or a language. These tests are the
 * boundary: every case below is something a merchant might plausibly send, and the ones
 * that are refused are refused because applying them would produce a panel a customer
 * could not read, could not find, or could be misled by.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, parseColor, resolveTheme, sanitizeFontStack } from "../protocol/src/theme.ts";

test("an ordinary brand colour is accepted, and the label colour is chosen for it", () => {
  const dark = resolveTheme({ accent: "#0b3d91" });
  assert.equal(dark.accent, "rgb(11, 61, 145)");
  assert.equal(dark.accentInk, "rgb(255, 255, 255)", "white on a dark navy");
  assert.deepEqual(dark.rejected, []);

  // A light brand colour gets black text, not white — the merchant does not get to pick,
  // because a merchant who could pick could pick their own background.
  const light = resolveTheme({ accent: "#ffd166" });
  assert.equal(light.accentInk, "rgb(0, 0, 0)");
});

test("every colour gets a readable label, because the ink is chosen and not configured", () => {
  // The worst case for a free choice between black and white ink sits around L = 0.18, and
  // it still clears 4.5:1 — which is why there is no rejection threshold here. A mid grey
  // is a legitimate brand colour and gets black or white, whichever wins.
  for (const colour of ["#767676", "#808080", "#6b7280", "#0b3d91", "#ffd166"]) {
    const result = resolveTheme({ accent: colour });
    assert.equal(result.rejected.length, 0, `${colour} was refused`);
    const rgb = parseColor(colour)!;
    const ink = parseColor(result.accentInk!)!;
    assert.ok(contrast(rgb, ink) >= 4.5, `${colour} label contrast is ${contrast(rgb, ink)}`);
  }
});

test("a button that would vanish into the card gets an edge, not a refusal", () => {
  // Near-white in light mode: readable label, invisible button. Refusing it would push the
  // merchant back to a panel that looks nothing like their site, which is the problem
  // theming exists to solve.
  const pale = resolveTheme({ accent: "#fdfdfd", scheme: "light" });
  assert.equal(pale.accent, "rgb(253, 253, 253)");
  assert.deepEqual(pale.rejected, []);
  assert.ok(pale.accentEdge, "a near-white button must get a visible border");
  // And the edge is derived from their own colour rather than being a colour of ours.
  assert.ok(contrast(parseColor(pale.accentEdge!)!, [255, 255, 255]) > 2.2);

  // A colour with plenty of contrast needs no edge.
  assert.equal(resolveTheme({ accent: "#0b3d91", scheme: "light" }).accentEdge, null);

  // In `auto` the button has to survive BOTH cards, so a near-black gets an edge too —
  // it would disappear on the dark one.
  assert.ok(resolveTheme({ accent: "#12161c" }).accentEdge, "near-black in auto needs an edge");
});

test("colour notations that are not colours do not become CSS", () => {
  for (const hostile of [
    "var(--anything)",
    "url(https://evil.test/x.png)",
    "red; position: fixed; inset: 0",
    "#fff; } .stop { display: none } .x {",
    "color-mix(in srgb, red, blue)",
    "rgb(300, 0, 0)",
    "linear-gradient(red, blue)",
    "expression(alert(1))",
    ""
  ]) {
    const result = resolveTheme({ accent: hostile });
    assert.equal(result.accent, null, `accepted ${JSON.stringify(hostile)}`);
  }
  // The parser is the boundary: whatever survives it is three numbers, and three numbers
  // cannot carry a declaration or a URL into a stylesheet.
  assert.equal(parseColor("#0b3d91")?.join(","), "11,61,145");
  assert.equal(parseColor("rgb(11, 61, 145)")?.join(","), "11,61,145");
  assert.equal(parseColor("chartreuse"), null, "named colours are not in the grammar either");
});

test("radius is clamped rather than refused", () => {
  assert.equal(resolveTheme({ radius: 0 }).radius, 0, "square corners are a real design");
  assert.equal(resolveTheme({ radius: 8 }).radius, 8);
  assert.equal(resolveTheme({ radius: 9999 }).radius, 24, "clamped, not honoured");
  assert.equal(resolveTheme({ radius: -4 }).radius, null);
  assert.equal(resolveTheme({ radius: Number.NaN }).radius, null);
});

test("font stacks name families; they never fetch one", () => {
  assert.equal(sanitizeFontStack("Inter, system-ui"), "Inter, system-ui");
  assert.equal(sanitizeFontStack('"Helvetica Neue", Arial'), '"Helvetica Neue", Arial');

  // This is the case that matters, and it is refused on a security ground rather than a
  // stylistic one: a font file controls which glyph a character draws, so a hostile one
  // could render "see this page and click and type on it as you" as "see this page" while
  // the DOM, the digest and the audit record all say the longer sentence. The customer
  // would be signing something they could not have read.
  for (const hostile of [
    "url(https://evil.test/f.woff2)",
    "Inter; } body { display: none } .x {",
    '"a", url(x)',
    "@import url(x)",
    "a,b,c,d,e,f,g"
  ]) {
    assert.equal(sanitizeFontStack(hostile), null, `accepted ${JSON.stringify(hostile)}`);
  }
});

test("the scheme is a closed set", () => {
  assert.equal(resolveTheme({ scheme: "dark" }).scheme, "dark");
  assert.equal(resolveTheme({ scheme: "light" }).scheme, "light");
  assert.equal(resolveTheme(null).scheme, "auto", "following the customer is the default");
  const bad = resolveTheme({ scheme: "invert" as "light" });
  assert.equal(bad.scheme, "auto");
  assert.equal(bad.rejected[0]!.token, "scheme");
});

test("there is no token for anything that would change the decision", () => {
  // The guard is structural — `ConsentTheme` has four fields — so this test is really a
  // statement of intent that a future field has to walk past. Each of these was considered
  // and refused for the reason beside it.
  const shape = Object.keys(
    resolveTheme({ accent: "#0b3d91", radius: 8, font: "Inter", scheme: "dark" })
  ).sort();
  assert.deepEqual(shape, ["accent", "accentEdge", "accentInk", "font", "radius", "rejected", "scheme"]);

  // Not present, and each absence is deliberate:
  //   stopColour       — semantic; a stop control in a calm brand blue is one people miss
  //   buttonOrder      — "Allow" as the only affordance is the dark pattern this refuses
  //   controlSize      — 44px is the floor for a fingertip
  //   text / wording   — refuse-list item 8
  //   hideOrigin       — the one fact the customer can check against their address bar
  //   opacity/position — the clickjacking surface
  for (const forbidden of ["stopColour", "buttonOrder", "controlSize", "text", "hideOrigin", "opacity"]) {
    assert.ok(!shape.includes(forbidden), `${forbidden} must not be themeable`);
  }
});

test("the contrast maths is the WCAG one", () => {
  // Anchors, so a refactor of the formula fails here rather than in a customer's eyes.
  assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21);
  assert.equal(Math.round(contrast([255, 255, 255], [255, 255, 255])), 1);
  assert.ok(contrast([11, 61, 145], [255, 255, 255]) > 4.5);
});

test("a hostile theme degrades to ours rather than to nothing", () => {
  const result = resolveTheme({
    accent: "url(x)",
    radius: -1,
    font: "url(evil)",
    scheme: "sideways" as "light"
  });
  assert.deepEqual(
    { accent: result.accent, radius: result.radius, font: result.font, scheme: result.scheme },
    { accent: null, radius: null, font: null, scheme: "auto" }
  );
  assert.equal(result.rejected.length, 4, "and every refusal is reported, not swallowed");
  assert.deepEqual(
    result.rejected.map((r) => r.token).sort(),
    ["accent", "font", "radius", "scheme"]
  );
});
