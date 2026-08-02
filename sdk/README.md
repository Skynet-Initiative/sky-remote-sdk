# sky-remote — co-browse SDK

Consent-first co-browse. A support agent can see — and, if the customer allows it, use —
one page of your site, for a bounded time, with a signature from the customer's own device
on exactly what they agreed to.

**This package renders no UI of its own except the consent panel.** Your launcher, your
"get help" button, your chat widget and everything around them are yours: you know what
your site looks like and we do not. The consent panel is the exception, and not by permission:
it is served from our origin and holds a key your page cannot reach, so it is the one surface
here that a merchant *cannot* restyle, reskin or usefully reproduce.
[Why](#the-consent-panel-is-not-yours).

- **Nothing happens on page load.** No connection, no cookie, no storage, no identifier
  read. Loading the bundle defines an API and does nothing else.
- **Zero runtime dependencies.** The shipped bundle contains only our own source, and the
  build refuses if any shipped package ever declares one. Published with npm provenance, so the
  registry shows you the commit and workflow that produced the bytes.
- **Sensitive values are protected by default and configuration fails closed.** Card numbers,
  CVVs, passwords and one-time codes are masked and untypeable with no configuration from you;
  the rest of the page stays legible so the agent can help. `privacy: "strict"` inverts this to
  an allowlist.

**Looking for the API?** [`API.md`](API.md) is the full reference — every method, option and
event, plus working integrations for React, Next.js, Vue, Svelte and plain JavaScript. This file
is the contract: what the product promises and what you cannot configure.

---

## Install

Two channels, and they are not alternatives — pick the one that matches whether you have a build
step. Both ship the same version from the same commit.

| | Use it when | Pinned by |
|---|---|---|
| **npm** | your site or widget has a build (React, Next.js, Vue, Svelte, a bundled chat widget) | your lockfile's integrity hash |
| **Script tag** | you paste HTML into a CMS, Shopify, WordPress — no build step | the SRI hash in the tag |

[`API.md`](API.md) has the React, Next.js, Vue and Svelte integrations for both.

### npm

```sh
npm install @skynet-initiative/sky-remote
```

```js
import { createSky } from "@skynet-initiative/sky-remote";

const sky = createSky({ workspace: "pk_live_…" });
```

The package has **zero runtime dependencies** — the tarball contains only our own source, and it
is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so
the registry can show you the commit and the workflow that built it.

Nothing about the security model changes on this channel. Your lockfile records an integrity hash
for the tarball exactly as SRI does for the script tag, and `npm install` does not silently
upgrade you — so the property embed rule 1 exists to protect is preserved, not traded away.

Importing `createSky` does **not** define `window.Sky`; a module that assigns a global is a module
that cannot be imported twice. The global exists only on the script-tag build.

### Script tag

```html
<script
  src="https://sdk.skynet-initiative.com/v/<version>/sky.js"
  integrity="sha384-…"
  crossorigin="anonymous"
  data-workspace="pk_live_…"
  defer></script>
```

**Take the version and its hash from
[`/integrity.json`](https://sdk.skynet-initiative.com/integrity.json)**, not from a snippet
someone pasted you. That file is generated from the bytes the origin actually serves, so it
cannot describe a file that is not there. Your project's install screen fills both in for you.

`/v/<version>/sky.js` is immutable: those bytes never change, which is what makes the
`integrity` hash safe to pin.

There is also `https://sdk.skynet-initiative.com/v1/sky.js`, which always serves the latest
build and therefore **cannot carry an integrity hash**. Use it while you are integrating;
do not ship it. SRI and silent auto-update are mutually exclusive, and this is a security
product (the integration contract, embed rule 1).


### Loading it before it has loaded

The script-tag build replays calls queued before the bundle arrived, so the snippet can go
in `<head>` with `defer` or `async`:

```html
<script>
  window.Sky = window.Sky || [];
  Sky.push(["on", "queued", () => showSpinner()]);
</script>
<script src="https://sdk.skynet-initiative.com/v/<version>/sky.js" async></script>
```

---

## The two ways a session starts

### 1. The customer raises their hand — no backend needed

```ts
Sky.on("queued", ({ legalName }) => setStatus(`Waiting for ${legalName}…`));
Sky.on("invited", () => setStatus("An agent is joining"));
Sky.on("ended", ({ reason }) => setStatus(`Finished (${reason})`));

document.querySelector("#help").addEventListener("click", () => {
  Sky.requestAssistance({ note: "Cannot apply my discount code" });
});
```

`requestAssistance()` **creates no session.** It puts a row in an agent's queue; only an
authenticated agent inside a merchant console can turn that into a session. The customer
gets to raise their hand and cannot start anything. `Sky.cancelRequest()` withdraws it.

### 2. Your own channel carries the invite

If you already hold a socket to your own backend — a chat SaaS does — push the invite down
*that* and our SDK holds no idle connection at all. Your backend receives
`session.invite` on its webhook and sends the two values to the page:

```ts
socket.on("cobrowse-invite", ({ invite, session }) => {
  Sky.present(invite, session);
});
```

Both start paths converge on the same code, so there is one attach path tested twice.

---

## Configuration

```ts
Sky.configure({
  workspace: "pk_live_…",      // usually set with data-workspace on the tag instead
  privacy: "standard",         // the default; "strict" is the allowlist tier
  mask: [".customer-notes"],   // masked in addition to what we detect
  block: [".internal-only"],   // not shown at all — an inert, unclickable region
  locale: "fr-FR"              // the consent panel's language
});
```

Or, on the script tag: `data-workspace`, `data-privacy`, `data-mask`, `data-block`,
`data-unmask` (comma separated), `data-locale`.

### What the agent sees, by default

**Sensitive values are protected with no configuration from you.** Card numbers, CVVs and
security codes, passwords, one-time codes, IBANs and account numbers arrive at the agent as
`••••` and the agent **cannot type into them**. Detection does not depend on you listing
anything: it fires on the field's `type`, its `autocomplete` token, the shape of its `name`,
`id` or `class`, its visible label, and — for a card number typed into a field named nothing in
particular — a Luhn check on the value itself.

**Everything else is legible.** Your headings, prices, product names, validation errors,
addresses, order references and the values a customer typed into ordinary fields are all
visible, and the agent can type into those fields. That is what makes the session useful: an
agent who cannot read the page cannot help with it.

If a field of yours is sensitive in a way the classifier cannot know — an internal risk score,
a free-text field customers paste account details into — name it:

```ts
mask:  [".risk-score"]      // value bulleted, layout preserved, not typeable
block: ["#admin-panel"]     // region not sent at all: inert and unclickable
```

`mask` is added to our detection, never replacing it. We also honour the markers you may
already have for another vendor without any configuration: `data-private`, `data-no-capture`,
`data-sensitive`, `.rr-mask`, `.fs-exclude`, `.ph-no-capture` and our own `data-sky-private`.

### `privacy: "strict"` — the allowlist tier

If you are in PCI scope, or your compliance function wants an allowlist rather than detection,
invert it:

```ts
privacy: "strict",
unmask: ["main", ".product-grid"]   // now load-bearing: nothing else is legible
```

In `strict`, **nothing** reaches the agent in the clear unless an `unmask` selector covers it.
This is the stronger and the more brittle setting — a subtree you forget is a subtree the agent
cannot read — which is why it is not the default. `block` always wins over `unmask`, at any
depth.

### Four things to know in either tier

- **Masked means untypeable.** A field whose value the agent cannot read is one they cannot
  type into. This is a security property, not a side effect: it stops an agent filling in a
  payment form they cannot see, on your customer's behalf.
- **`password` and `tel` are never showable.** No tier and no selector exposes them, so
  `strict` can never be weaker than `standard`.
- **Configuration fails closed.** An invalid selector, or a `privacy` value that is not
  `"standard"` or `"strict"`, throws at `configure()` time rather than being skipped.
  Protecting less than you asked for, silently, is the one failure mode this must not have.
- **`email` is legible by default** (`standard` tier). It is the thing agents most often need
  to read back. Add it to `mask` if your threat model differs.

**What masking does not cover, stated plainly.** `class`, `id`, `style`, `role`, `aria-*` and
every `data-*` are sent unmasked, because they are what your CSS selects on and masking them
turns the mirror back into unstyled HTML. Labels — `alt`, `placeholder`, `aria-label`, `title` —
are also sent in the clear, because they are your interface's own wording and an agent needs
them to tell a customer which box to fill in. Do not put customer data in a `data-` attribute or
a `placeholder` and expect it to be protected; put it behind a `mask` or `block` selector.

---

## Content-Security-Policy

**If you have a CSP, this is the section that decides whether the integration works.** The
most common failure is silent: `frame-src` blocks the consent panel, the customer sees
nothing, and the only evidence is a console message on their machine.

| Directive | Value | Why |
| --- | --- | --- |
| `script-src` | `https://sdk.skynet-initiative.com` | Only if you load the script tag. Not needed when you bundle. |
| `frame-src` | `https://consent.skynet-initiative.com` | **The one that silently kills consent.** The panel is a cross-origin iframe. |
| `connect-src` | `wss://remote.skynet-initiative.com` | The signalling socket. |
| `img-src` | `https:` | Your own logo in the consent panel header, if you set one. |

```
Content-Security-Policy:
  script-src 'self' https://sdk.skynet-initiative.com;
  frame-src  https://consent.skynet-initiative.com;
  connect-src 'self' wss://remote.skynet-initiative.com;
```

Notes:

- **`child-src` is the fallback for `frame-src`.** If you set `child-src` and not
  `frame-src`, add the consent origin there instead.
- **`default-src` counts.** If you have `default-src 'self'` and no `frame-src`, the panel
  is blocked. There is no directive you can omit your way out of.
- **We need no `style-src` exception on your page.** All of our styling is inside our own
  frame, under our own policy.
- **We need no `unsafe-inline` or `unsafe-eval` anywhere.** There is no `eval`, no
  `new Function` and no dynamic script insertion in this bundle.
- If you use `require-trusted-types-for 'script'`, this bundle never assigns to
  `innerHTML`, so it needs no policy.

Checking it: open the consent panel once on a staging page with your production CSP. A
blocked frame reports `Refused to frame 'https://consent.skynet-initiative.com/'` in the
console, and `sky.on("invited")` fires while nothing appears on screen.

---

## Single-page applications

Nothing to do. The mirror follows the DOM, and a route change — `pushState`, a router, a
full re-render — is detected and re-snapshotted so the agent is never looking at a page
assembled half from one route and half from another. Code-split stylesheets loaded by the
new route are picked up when they load.

There is exactly **one** instance per page and the bundle creates it, so the class of bug where
two state machines fight over one page cannot happen. `window.Sky` is that instance; share it, and
remove any listener you add when a component unmounts, because the instance outlives it.

### React, Next.js, Vue, Svelte

The same shape everywhere: wait for the bundle once, subscribe in the mount hook, unsubscribe in
the teardown hook. There is no framework-specific build, because there is nothing
framework-specific in the API — it is an event emitter and five methods.

`Sky.off` exists precisely so a component can unsubscribe, and a listener that outlives its
component is the usual way an SDK leaks in a single-page app.

**Copy-paste integrations for each framework are in [`API.md`](API.md)**, including the
`whenReady()` helper, the Next.js `next/script` placement, and the one thing worth getting right:
with a single shared instance, a component that calls `stop()` unconditionally on unmount will end
a session another part of the app started.

### Server-side rendering

There is nothing to import, so nothing can evaluate on the server. Put the tag in your HTML
shell (Next.js: `next/script` with `strategy="afterInteractive"`; Nuxt: `app.head`; SvelteKit:
`app.html`) and touch `window.Sky` only from client code — a mounted effect, `onMounted`, or
`onMount`. [`API.md`](API.md) has the exact placement for each.

---

## Events

| Event | When |
| --- | --- |
| `state` | The one-word state changed: `idle`, `requesting`, `queued`, `invited`, `live`, `paused`, `ended` |
| `queued` | The customer is in an agent's queue |
| `cancelled` | The request was withdrawn or timed out before anyone answered |
| `invited` | An agent answered; the consent panel is opening |
| `consented` | The customer agreed. Carries the capability they agreed to |
| `capability` | They narrowed it — dropped control, or paused entirely |
| `obscured` / `visible` | The consent panel was covered or came back. Streaming stops and resumes with it |
| `ended` | Over, with a reason |
| `error` | Something failed, with `where` |
| `degraded` | Fidelity was reduced. Almost always a third-party stylesheet served without CORS headers |

---

## The consent panel is not yours

It is a cross-origin iframe served from `consent.skynet-initiative.com`, and your page
cannot read it, script it, restyle it or resize it.

**Can a page fake it?** It can draw a pixel-perfect copy. It gains nothing:

- **A fake panel cannot produce consent.** The session private key is generated inside our
  origin, is non-extractable, and never leaves. The engine accepts a signature only over the
  descriptor it issued, and only from a socket whose browser-set `Origin` is the consent
  origin. Copying the pixels produces no signature, and therefore no session.
- **A fake panel cannot hide the real one.** The real one is in the browser's top layer —
  above every stacking context regardless of `z-index`, and unaffected by an ancestor's
  `transform`, `filter` or `opacity`.
- **A fake "stop" cannot make sharing continue invisibly.** If the real panel is covered,
  faded, scrolled away or detached, two independent checks — one inside the frame, one in
  this bundle — narrow the capability to zero surfaces. Hiding the panel stops the session.
  It does not conceal it.

The panel shows the origin **the browser reported**, not a name we were told. The customer
can check it against their own address bar and no integrator can forge it.

What you *can* configure: your legal name and logo (subject to verification), the capability
ceiling within your profile's maximum, the masking opt-outs above, the session duration
within the platform cap, and the panel's language. What you cannot: the consent wording, the
presence of the indicator, the customer's stop control, or the audit stream. That split is
the product boundary.

---

## What the agent sees, and what they cannot

The agent gets a live rendering of the one page, built from a typed node model — never
`innerHTML`, with scripts off in their viewer. Regions we could not faithfully represent
arrive **marked with a reason**, are rendered as visibly inert, and **input into them is
refused** at the moment of dispatch against your live DOM:

| Region | Why |
| --- | --- |
| `<iframe>`, `<frame>`, `<object>`, `<embed>` | We serialize only our own document. A payment frame stays a rectangle. |
| Any shadow host, open or closed | A shadow tree is not in `childNodes`. |
| `<canvas>`, `<video>`, `<audio>` | The element is representable; the drawing is not. |
| Any masked field | An agent may not type into a field whose contents they cannot read. |

Known fidelity limits, so you can decide before you integrate rather than after:

- **A cross-origin stylesheet served without `Access-Control-Allow-Origin` cannot be read
  from your page.** It is referenced by URL instead and loaded by the agent's browser, which
  works but means their browser fetches your CDN. You get a `degraded` event naming it.
- **Masked text changes text metrics.** Bullets are not the same width as letters, so an
  element sized by masked text differs from the customer's screen. In the `standard` tier this
  is confined to the sensitive fields themselves; in `strict` it affects the whole page until
  you `unmask` it.
- **Content inside a cross-origin iframe needs the SDK inside that frame too.** This is an
  integration requirement, not a bug we can fix.

---

## Browser support

Chrome/Edge 100+, Firefox 100+, Safari 15.4+.

The hard floor is **Ed25519 in WebCrypto**, which is what binds consent to the customer's
device. Where it is missing, the panel says so and refuses rather than degrading to an
unsigned "I agree" — consent that cannot be cryptographically bound is not the consent this
product promises.

## Licence

**[Business Source License 1.1](../LICENSE)** — source-available, not open source. The file is
what counts; this is what it says:

- **Run it in production on sites and apps you operate, free, with no limit** on users, sessions
  or page views. Install it from npm, bundle it, self-host the output, modify it.
- **Do not build a co-browse, screen-sharing or remote-assistance product out of it** and offer
  that to other people.
- **Read it, run it, test it and publish a security review of it.** No permission needed, and the
  licence says so explicitly rather than leaving you to infer it.
- **On 2030-08-02 it becomes Apache-2.0**, automatically, for every version released under these
  terms.

If you are integrating this into your own site or product, the first bullet is the whole of your
relationship with it and nothing about your install changes.

It was Apache-2.0 until this source went public. Apache-2.0 granted redistribution and
modification without qualification — the one right worth withholding — while protecting nothing,
since the bundle ships to every visitor's browser regardless. Obfuscating it was the alternative
and it was rejected: it would have broken [`VERIFYING.md`](../VERIFYING.md), which is the thing
doing real work here.

Two things no licence here gives or takes away. It grants no rights in Skynet Initiative's names
or marks, and it cannot make a copy of the consent panel *work* — see
[above](#the-consent-panel-is-not-yours): what stops a forged panel is a non-extractable key
inside our origin and an engine that checks the browser-set `Origin`, not a term in a licence.
