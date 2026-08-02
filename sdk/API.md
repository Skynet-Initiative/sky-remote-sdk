# sky-remote SDK — API reference

Everything the browser SDK exposes, and how to drive it from the framework you already use.

`README.md` is the integration contract — what the product promises, what you cannot configure,
and why. This file is the reference: every method, option and event, plus a working integration
for React, Next.js, Vue, Svelte and plain JavaScript.

**There is nothing framework-specific in the SDK.** It is one object with methods and an event
emitter, with zero runtime dependencies and no UI of its own except the consent panel. The
framework sections below differ only in where you put your listeners and how you clean them up.

---

## Contents

- [Install](#install)
- [The one instance](#the-one-instance)
- [The lifecycle](#the-lifecycle)
- [Methods](#methods)
- [Options](#options)
- [Events](#events)
- [TypeScript](#typescript)
- [React](#react) · [Next.js](#nextjs) · [Vue](#vue) · [Svelte](#svelte) · [Plain JavaScript](#plain-javascript)
- [Pitfalls](#pitfalls)

---

## Install

Two channels, same bytes, same version. Pick by whether you have a build step.

### npm — if your app has a bundler

```sh
npm install @skynet-initiative/sky-remote
```

```ts
import { createSky } from "@skynet-initiative/sky-remote";

const sky = createSky({ workspace: "pk_live_…" });
```

`createSky` returns the instance directly, so none of the load-order machinery below applies —
skip to [Methods](#methods). Importing does **not** define `window.Sky`; a module that assigns a
global is one that cannot be imported twice.

Your lockfile pins the tarball by integrity hash, which is the same guarantee SRI gives the script
tag, and the package is published with provenance — `npm audit signatures` shows you the commit and
workflow that built it.

That commit is in a repository you can read, and you can go further than checking the signature:
`node verify.mjs <version>` rebuilds the release from its tag and compares it to the tarball on
npm, byte for byte. [`VERIFYING.md`](../VERIFYING.md) is the three-command version. This is a
package that runs in your customers' pages with full DOM access, so it is worth doing once.

### Script tag — if you paste HTML

```html
<script
  src="https://sdk.skynet-initiative.com/v/<version>/sky.js"
  integrity="sha384-…"
  crossorigin="anonymous"
  data-workspace="pk_live_…"
  defer></script>
```

That is the whole installation. The file creates the instance and publishes it as `window.Sky`.

- **`/v/<version>/sky.js` is immutable.** Those exact bytes never change, which is what makes the
  `integrity` hash safe to pin. Get the current hash from
  [`/integrity.json`](https://sdk.skynet-initiative.com/integrity.json) rather than from a snippet
  someone pasted you — your dashboard's Install screen fills it in for you.
- **`/v1/sky.js`** always serves the latest build and therefore **cannot carry an integrity
  hash**. Fine while you are integrating; do not ship it. SRI and silent auto-update are mutually
  exclusive, and this is a security product.

**Reviewing the masking policy?** Read [`privacy.ts`](src/privacy.ts) — it is public, and it is
39% comments, which is where the reasoning lives. There is deliberately no separate unminified
build: `esbuild` strips those comments, so it carried the code with none of the argument.

**Loading it does nothing.** No connection, no cookie, no storage, no identifier read, until you
call a method. There is no `localStorage`, `sessionStorage`, `document.cookie` or `indexedDB`
anywhere in the bundle.

### Configuration on the tag

`data-workspace`, `data-privacy`, `data-mask`, `data-block`, `data-unmask` (comma-separated
selector lists), `data-locale`. Anything you would pass to [`configure()`](#configureoptions-resolvedconfig)
can go here instead.

### Calling it before it has loaded

The bundle replays calls queued before it arrived, so the tag can go in `<head>` with `defer` or
`async` and your app never has to wait for it:

```html
<script>
  window.Sky = window.Sky || [];
  Sky.push(["on", "queued", () => showSpinner()]);
  Sky.push(["configure", { locale: "fr-FR" }]);
</script>
<script src="https://sdk.skynet-initiative.com/v/<version>/sky.js" async></script>
```

Each entry is `[methodName, ...args]`. Once the bundle loads, `window.Sky` becomes the real API
object and the queue is applied in order. This is the mechanism the framework examples below use
to avoid caring about load order.

### Is it an ES module?

`sky.js` is not — it is a classic script that assigns a global, so **`import` from that URL will
not work**. If you want modules, install from npm instead; the package ships ESM and CJS builds
and exports `createSky`.

If you are on the script tag in a bundled app, load it with the tag (in your `index.html`, or
Next.js's `<Script>`) and reference `window.Sky`. Nothing is lost: the API is identical either way.

---

## The one instance

There is exactly one instance per page and the bundle creates it. `window.Sky` *is* that instance
— there is no constructor to call and no second instance to create, so the whole class of "two
sockets racing for one session" bugs cannot happen.

Waiting for it, once, in a helper you can reuse:

```ts
export function sky(): Promise<SkyApi> {
  return new Promise((resolve) => {
    const ready = () =>
      !Array.isArray(window.Sky) && typeof window.Sky === "object"
        ? (resolve(window.Sky as SkyApi), true)
        : false;
    if (ready()) return;
    const timer = setInterval(() => { if (ready()) clearInterval(timer); }, 20);
  });
}
```

Or skip it entirely and use the queue: `window.Sky.push(["on", …])` works before *and* after the
bundle lands, because the real object also has a `push`-compatible entry point for the same calls.
The examples below prefer the explicit helper, because a promise is easier to reason about inside a
component's lifecycle.

---

## The lifecycle

`Sky.state` is one word, and every event is a detail of one of these:

```
idle ──requestAssistance()──▶ requesting ──▶ queued ──▶ invited ──▶ live ──▶ ended
 │                                              │                    ▲ │
 └──────────present(invite, session)────────────┘                    │ ▼
                                                                    paused
```

| State | Meaning |
| --- | --- |
| `idle` | Nothing is happening. Nothing has touched the device. |
| `requesting` | `requestAssistance()` is in flight. |
| `queued` | The customer is in an agent's queue. Nobody has joined. |
| `invited` | An agent started a session; the consent panel is up. |
| `live` | The customer consented. The page is being mirrored. |
| `paused` | Streaming stopped locally — the panel was covered, faded, or the tab hidden. Recovers on its own. |
| `ended` | Over. Terminal. |

`paused` is not an error and needs no handling; nothing streams while the customer's stop control
is not reachable. It resolves itself when the panel is visible again.

---

## Methods

### `configure(options?): ResolvedConfig`

Merge options in and return the resolved configuration. Throws on an invalid selector or an
unknown `privacy` tier rather than guessing — protecting less than you asked for, silently, is the
one failure mode this must not have.

```ts
Sky.configure({ privacy: "strict", unmask: ["main", ".product-grid"] });
```

### `requestAssistance(options?): void`

The customer raises their hand. Takes the same options as `configure`, plus `note`.

**This creates no session.** It puts a row in an agent's queue; only an authenticated agent in a
merchant console can turn that into one. A customer can ask, and cannot start anything.

```ts
Sky.requestAssistance({ note: "Cannot apply my discount code" });
```

### `cancelRequest(): void`

Withdraw a queued request. No effect once a session is live.

### `present(invite, session, options?): void`

Attach to a session your own backend was told about, when you already hold a socket to it and
would rather not have ours idle. Your backend receives `session.invite` on its webhook and sends
the two values down your own channel.

```ts
socket.on("cobrowse-invite", ({ invite, session }) => { Sky.present(invite, session); });
```

### `stop(): void`

End the session from the page. The customer's own stop control lives in the consent panel and is
not suppressible — this is for your UI's own "end session" affordance, not a replacement for it.

Safe in any state and safe to call twice.

### `on(event, fn)` / `off(event, fn)`

Subscribe and unsubscribe. Both return the instance, so they chain:

```ts
Sky.on("live", onLive).on("ended", onEnded);
```

A listener that throws is caught and warned about; it cannot break the session. **Always `off`
what you `on`** in a component that unmounts — the instance outlives your component.

### Read-only properties

| Property | Type | |
| --- | --- | --- |
| `Sky.version` | `string` | The SDK's version, e.g. `"0.1.0"`. |
| `Sky.protocol` | `number` | The wire protocol version. |
| `Sky.state` | `SkyState` | The current state word. |
| `Sky.active` | `boolean` | Is a session in progress? |

---

## Options

```ts
interface SkyOptions {
  workspace?: string;
  privacy?: "standard" | "strict";
  mask?: string[];
  block?: string[];
  unmask?: string[];
  locale?: string;
}
```

| Option | Default | |
| --- | --- | --- |
| `workspace` | — | Your publishable key, `pk_live_…`. Public by design; it grants nothing. |
| `privacy` | `"standard"` | `"standard"` shows the page and protects what we detect as sensitive. `"strict"` shows nothing that `unmask` names. |
| `mask` | built-in markers | Selectors whose text and values are masked, on top of what we detect. Appended, never replacing. |
| `block` | `[]` | Selectors not sent at all — the region is inert and unclickable, not merely bulleted. |
| `unmask` | `[]` | Selectors shown in the clear. Only load-bearing in `strict`. |
| `locale` | `<html lang>` | BCP-47 tag for the consent panel. |

Card numbers, CVVs, security codes, passwords, one-time codes and bank details are masked **and
untypeable** with no configuration from you. Every option here can only ever make the agent see
*less*: there is no option that widens what an agent may do, changes the consent wording, or
removes the stop control.

We also honour the markers you may already have for another vendor, with no configuration:
`data-private`, `data-no-capture`, `data-sensitive`, `.rr-mask`, `.fs-exclude`, `.ph-no-capture`
and our own `data-sky-private`.

---

## Events

| Event | Detail | When |
| --- | --- | --- |
| `state` | `{ state, previous }` | The state word changed. The one to drive UI from. |
| `requesting` | `{}` | A request is in flight. |
| `queued` | `{ requestId, workspaceId, legalName, expiresIn }` | In the queue. `legalName` is the merchant's verified name. |
| `cancelled` | `{}` | The queued request was withdrawn. |
| `invited` | `{ session }` | An agent joined; the consent panel is up. |
| `consented` | `{ current }` | The customer signed. Carries the capability they agreed to. |
| `capability` | `{ current }` | The capability changed mid-session — the customer narrowed or widened it. |
| `obscured` | `{ reason }` | Streaming paused because the panel is not properly visible. |
| `visible` | `{}` | Visible again; streaming resumed. |
| `ended` | `{ reason }` | Over, with why. |
| `error` | `{ where, error? }` | Something failed. `where` names the stage. |
| `degraded` | `{ what }` | Fidelity was reduced — usually an unreadable third-party stylesheet. Log it; do not show it. |

Read `current.access` for `view` vs `control`, and `current.surfaces.length` to know whether
anything is streaming.

---

## TypeScript

There is no package to install types from, so declare the global once. Drop this in
`sky-remote.d.ts` anywhere in your project's `include`:

```ts
// sky-remote.d.ts
type SkyState = "idle" | "requesting" | "queued" | "invited" | "live" | "paused" | "ended";

interface SkyCapability {
  access: "view" | "control";
  surfaces: { kind: string }[];
  tier: string;
  clipboard: string;
  file_transfer: string;
}

interface SkyOptions {
  workspace?: string;
  privacy?: "standard" | "strict";
  mask?: string[];
  block?: string[];
  unmask?: string[];
  locale?: string;
}

interface SkyEvents {
  state: { state: SkyState; previous: SkyState };
  requesting: Record<string, never>;
  queued: { requestId: string; workspaceId: string; legalName: string; expiresIn: number };
  cancelled: Record<string, never>;
  invited: { session: string };
  consented: { current: SkyCapability };
  capability: { current: SkyCapability };
  obscured: { reason: string | null };
  visible: Record<string, never>;
  ended: { reason: string };
  error: { where: string; error?: string };
  degraded: { what: string };
}

interface SkyApi {
  readonly version: string;
  readonly protocol: number;
  readonly state: SkyState;
  readonly active: boolean;
  configure(options?: SkyOptions): SkyOptions & { workspaceKey: string | null };
  requestAssistance(options?: SkyOptions & { note?: string }): void;
  cancelRequest(): void;
  present(invite: string, session: string, options?: SkyOptions): void;
  stop(): void;
  on<K extends keyof SkyEvents>(event: K, fn: (detail: SkyEvents[K]) => void): SkyApi;
  off<K extends keyof SkyEvents>(event: K, fn: (detail: SkyEvents[K]) => void): SkyApi;
}

declare global {
  interface Window {
    Sky: SkyApi | [string, ...unknown[]][];
  }
}
```

With that in place, `on`/`off` infer their detail type and there is nothing to cast.

---

## React

One hook, shared by every component that needs the session. The listeners are registered when the
bundle is ready and removed on unmount.

```tsx
// use-sky.ts
import { useCallback, useEffect, useRef, useState } from "react";

/** Resolves once the bundle has replaced the queue array with the real object. */
function whenReady(): Promise<SkyApi> {
  return new Promise((resolve) => {
    const got = () => {
      const S = window.Sky;
      if (!Array.isArray(S) && typeof S === "object") { resolve(S); return true; }
      return false;
    };
    if (got()) return;
    const timer = window.setInterval(() => { if (got()) window.clearInterval(timer); }, 20);
  });
}

export function useSky() {
  const ref = useRef<SkyApi | null>(null);
  const [state, setState] = useState<SkyState>("idle");
  const [merchant, setMerchant] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const onState = ({ state }: SkyEvents["state"]) => setState(state);
    const onQueued = ({ legalName }: SkyEvents["queued"]) => setMerchant(legalName);

    void whenReady().then((sky) => {
      if (!live) return;
      ref.current = sky;
      setState(sky.state);
      sky.on("state", onState).on("queued", onQueued);
    });

    return () => {
      live = false;
      // The instance outlives this component, so the listeners must not.
      ref.current?.off("state", onState).off("queued", onQueued);
      // Only if this component owns the session — see Pitfalls.
      if (ref.current?.active) ref.current.stop();
      ref.current = null;
    };
  }, []);

  const requestHelp = useCallback((note?: string) => {
    ref.current?.requestAssistance(note ? { note } : undefined);
  }, []);
  const cancel = useCallback(() => ref.current?.cancelRequest(), []);

  return { state, merchant, requestHelp, cancel };
}
```

```tsx
export function HelpButton() {
  const { state, merchant, requestHelp, cancel } = useSky();

  if (state === "queued")
    return (
      <div>
        <p>Waiting for {merchant ?? "an agent"}…</p>
        <button onClick={cancel}>Cancel</button>
      </div>
    );
  if (state === "live") return <p>An agent is helping you.</p>;
  if (state === "paused") return <p>Sharing paused — bring the panel back on screen.</p>;

  return (
    <button onClick={() => requestHelp("Cannot apply my discount code")} disabled={state === "requesting"}>
      {state === "requesting" ? "Connecting…" : "Get help with this page"}
    </button>
  );
}
```

Put the script tag in `index.html`. Under React 18+ Strict Mode the effect runs twice in
development; the cleanup above makes that harmless.

## Next.js

Load the tag with `next/script` and keep everything else in a client component. There is nothing
to import, so nothing can leak into the server bundle.

```tsx
// app/layout.tsx
import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="https://sdk.skynet-initiative.com/v/<version>/sky.js"
          integrity="sha384-…"
          crossOrigin="anonymous"
          data-workspace="pk_live_…"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
```

```tsx
// components/help-button.tsx
"use client";
import { useSky } from "@/hooks/use-sky"; // the hook above, unchanged

export function HelpButton() {
  const { state, requestHelp } = useSky();
  return (
    <button onClick={() => requestHelp()} disabled={state !== "idle" && state !== "ended"}>
      Get help with this page
    </button>
  );
}
```

`strategy="afterInteractive"` is deliberate: the bundle does nothing on load, so there is no
reason to block first paint for it, and the queue pattern means an early click still works if you
push instead of calling.

## Vue

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

const state = ref<SkyState>("idle");
const merchant = ref<string | null>(null);
let sky: SkyApi | null = null;

const onState = (d: SkyEvents["state"]) => { state.value = d.state; };
const onQueued = (d: SkyEvents["queued"]) => { merchant.value = d.legalName; };

onMounted(async () => {
  sky = await whenReady();          // the helper from the React section
  state.value = sky.state;
  sky.on("state", onState).on("queued", onQueued);
});

onUnmounted(() => {
  sky?.off("state", onState).off("queued", onQueued);
  if (sky?.active) sky.stop();
  sky = null;
});

const requestHelp = () => sky?.requestAssistance({ note: "Stuck at checkout" });
</script>

<template>
  <p v-if="state === 'queued'">Waiting for {{ merchant ?? "an agent" }}…</p>
  <p v-else-if="state === 'live'">An agent is helping you.</p>
  <button v-else :disabled="state === 'requesting'" @click="requestHelp">
    Get help with this page
  </button>
</template>
```

## Svelte

```svelte
<script lang="ts">
  import { onMount } from "svelte";

  let sky: SkyApi | null = null;
  let state: SkyState = "idle";
  let merchant: string | null = null;

  const onState = (d: SkyEvents["state"]) => (state = d.state);
  const onQueued = (d: SkyEvents["queued"]) => (merchant = d.legalName);

  onMount(() => {
    let live = true;
    void whenReady().then((s) => {
      if (!live) return;
      sky = s;
      state = s.state;
      s.on("state", onState).on("queued", onQueued);
    });
    return () => {
      live = false;
      sky?.off("state", onState).off("queued", onQueued);
      if (sky?.active) sky.stop();
      sky = null;
    };
  });
</script>

{#if state === "queued"}
  <p>Waiting for {merchant ?? "an agent"}…</p>
{:else if state === "live"}
  <p>An agent is helping you.</p>
{:else}
  <button disabled={state === "requesting"} on:click={() => sky?.requestAssistance()}>
    Get help with this page
  </button>
{/if}
```

In SvelteKit, `onMount` only runs in the browser, so no extra guard is needed.

## Plain JavaScript

```html
<button id="help">Get help with this page</button>
<p id="status"></p>

<script
  src="https://sdk.skynet-initiative.com/v/<version>/sky.js"
  integrity="sha384-…"
  crossorigin="anonymous"
  data-workspace="pk_live_…"
  defer></script>

<script defer>
  document.addEventListener("DOMContentLoaded", function () {
    var status = document.getElementById("status");

    Sky.on("state", function (d) { status.textContent = d.state; });
    Sky.on("queued", function (d) { status.textContent = "Waiting for " + d.legalName + "…"; });
    Sky.on("ended", function (d) { status.textContent = "Finished (" + d.reason + ")"; });

    document.getElementById("help").addEventListener("click", function () {
      Sky.requestAssistance({ note: "Cannot apply my discount code" });
    });
  });
</script>
```

Both `defer` scripts run in order, so `Sky` is the real API by the time the second one executes. If
you cannot guarantee ordering, use the [queue pattern](#calling-it-before-it-has-loaded).

---

## Pitfalls

**Trying to `npm install` it.** There is no published package. If you saw
`npm install @skynet-initiative/sky-remote` anywhere, it is wrong — the script tag is the install.

**Trying to `import` the CDN URL.** `sky.js` is a classic script that assigns a global, not an ES
module.

**Leaking listeners.** The instance is a page-level singleton that outlives your components. Every
`on` in a component needs a matching `off` on unmount, or a remounted view accumulates handlers.

**Calling `stop()` unconditionally on unmount.** With one shared instance, a component that stops
the session on unmount will kill a session another part of the app started. Guard on `active`, or
own the session in one place.

**Expecting `requestAssistance()` to start a session.** It queues. An agent starts it. If nothing
happens, look at the agent's queue, not at the SDK.

**Putting customer data in a `data-` attribute or a `placeholder`.** Those are sent in the clear:
`data-*` is what your CSS selects on, and label attributes are your interface's own wording.
Protect values with `mask` or `block`.

**A Content-Security-Policy that blocks the consent frame.** The most common integration failure
and it is silent — the customer sees nothing. The README's CSP section lists exactly what to allow.

**Assuming `control` means the agent can act everywhere.** Anything we could not represent —
cross-origin frames, closed shadow roots, canvas, and every masked field — refuses input. If we
cannot show it, we cannot touch it.

**Expecting the page to decide `view` vs `control`.** It cannot, deliberately. The merchant's
ceiling is configured in the dashboard, the agent requests within it, and the customer consents on
their own device. The integrating page has no say at any point.
