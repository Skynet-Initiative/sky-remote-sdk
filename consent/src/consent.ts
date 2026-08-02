/*!
 * The consent surface.
 *
 * Served from its own origin and embedded cross-origin in the merchant's page. Three
 * things live here and nowhere else, and each is the reason the surface exists at all:
 *
 *  1. THE SESSION PRIVATE KEY. Generated here, non-extractable, never leaves this origin.
 *     The merchant's page and our own in-page SDK cannot read it even if both are fully
 *     compromised, which is what makes the consent signature unforgeable by anyone but the
 *     person at the keyboard (docs/03-trust-model.md obligation 1).
 *
 *  2. THE DIGEST THE CUSTOMER SIGNS. Recomputed here from the fields actually rendered,
 *     not taken from the engine. A frame that signed a supplied digest could be shown one
 *     set of terms and made to sign another.
 *
 *  3. THE STOP CONTROL. On this frame's own socket to the engine, so revocation does not
 *     depend on the SDK cooperating. A compromised SDK can stop sending frames; it cannot
 *     stop the customer stopping the session.
 *
 * The self-checks below fail CLOSED: if this surface is clipped, hidden, detached or
 * covered, the capability narrows to nothing and streaming stops. Clickjacking the revoke
 * control is the web equivalent of hiding the on-screen indicator.
 *
 * **Geometry is not ours.** This file names a state — `ask`, `indicator`,
 * `indicator-alert`, `gone` — and the SDK owns the numbers. A surface that could ask for
 * any height could cover the page it is supposed to sit beside, and a surface that sized
 * itself from its content could be cropped by a long paragraph. Neither is representable
 * now.
 */

import {
  canonicalDigest,
  resolveTheme,
  toBase64,
  type Capability,
  type ConsentDescriptor,
  type ConsentSurfaceState,
  type EndReason,
  type FrameToPage,
  type InboundFrame,
  type ConsentTheme,
  type PageToFrame
} from "../../protocol/src/index.js";

const PROTOCOL = 1;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    // A missing element is a build error, not a runtime condition, and it must not be
    // survivable: the previous version referenced a `#facts` list the markup no longer
    // had, so `renderOffer` threw and the customer got "Cannot share this page" instead of
    // a consent panel. Failing here names the element.
    throw new Error(`consent surface: #${id} is missing from index.html`);
  }
  return node as T;
}

const ui = {
  shell: el<HTMLDivElement>("shell"),
  logo: el<HTMLImageElement>("logo"),
  who: el("who"),
  origin: el("origin"),
  loading: el("loading"),
  ask: el("ask"),
  live: el("live"),
  over: el("over"),
  askTitle: el("ask-title"),
  scope: el("scope"),
  verify: el("verify"),
  allow: el<HTMLButtonElement>("allow"),
  deny: el<HTMLButtonElement>("deny"),
  dot: el("dot"),
  liveLabel: el("live-label"),
  liveDetail: el("live-detail"),
  viewOnly: el<HTMLButtonElement>("view-only"),
  stop: el<HTMLButtonElement>("stop"),
  close: el<HTMLButtonElement>("close"),
  overTitle: el("over-title"),
  overDetail: el("over-detail"),
  warn: el("warn"),
  askActions: el("ask-actions"),
  liveActions: el("live-actions"),
  overActions: el("over-actions"),
  announce: el("announce")
};

interface State {
  /** The embedder's origin, as the BROWSER reported it on the first message. Not a value
   *  the page passed us in a payload — `event.origin` is set by the browser and a page
   *  cannot lie about it. This is the one fact here the customer can independently check. */
  parentOrigin: string | null;
  parentWindow: Window | null;
  session: string;
  invite: string;
  signal: string;
  socket: WebSocket | null;
  keys: CryptoKeyPair | null;
  descriptor: ConsentDescriptor | null;
  current: Capability | null;
  agents: number;
  /** Two independent facts, combined rather than folded into one flag. Collapsing them
   *  means a tab that goes to the background and comes back stays "not visible" until the
   *  next intersection change, which may never come. */
  intersecting: boolean;
  tabVisible: boolean;
  parentSaysVisible: boolean;
  consented: boolean;
  ended: boolean;
}

const state: State = {
  parentOrigin: null,
  parentWindow: null,
  session: "",
  invite: "",
  signal: "",
  socket: null,
  keys: null,
  descriptor: null,
  current: null,
  agents: 0,
  intersecting: true,
  tabVisible: true,
  parentSaysVisible: true,
  consented: false,
  ended: false
};

// ---------------------------------------------------------------------------
// The handshake with the embedding page
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent) => {
  // Only the window that embeds us. A message from anywhere else — another frame, an
  // opener, a page that guessed this URL — is not the page we are consenting about.
  if (event.source !== window.parent) return;
  const message = (event.data || {}) as PageToFrame;

  if (message.type === "sky.init") {
    if (state.session) return; // already initialised; a second init is not an init
    state.parentOrigin = event.origin;
    state.parentWindow = event.source as Window;
    state.session = String(message.session || "");
    state.invite = String(message.invite || "");
    state.signal = String(message.signal || "");
    if (message.locale) document.documentElement.lang = String(message.locale);
    ui.origin.textContent = event.origin;
    void start().catch(fatal);
    return;
  }
  if (event.origin !== state.parentOrigin) return;

  if (message.type === "sky.geometry") {
    // The parent's own occlusion check. It sees things this frame cannot — an element
    // covering us, an ancestor with `opacity`. Trusted only to make things WORSE:
    // `ok: true` from the parent never overrides our own finding, because the parent is
    // the party a compromise would come from.
    state.parentSaysVisible = message.ok !== false;
    evaluateVisibility(message.reason || "obscured");
    return;
  }
  if (message.type === "sky.stop") {
    revoke("The page closed the support session.");
  }
});

// Tell the embedder we are up, in case it loaded us before it was ready to send
// `sky.init`. `"*"` is safe here and nowhere else in this file: the message carries
// nothing.
window.parent.postMessage({ type: "sky.ready" } satisfies FrameToPage, "*");

function toParent(message: FrameToPage): void {
  if (state.parentWindow && state.parentOrigin) {
    state.parentWindow.postMessage(message, state.parentOrigin);
  }
}

/** Name a shape. The SDK owns what it measures. */
function shape(next: ConsentSurfaceState): void {
  if (next !== "gone") ui.shell.dataset.shape = next === "ask" ? "ask" : "indicator";
  ui.shell.setAttribute("aria-modal", next === "ask" ? "true" : "false");
  toParent({ type: "sky.state", state: next });
}

// ---------------------------------------------------------------------------
// Start: keys, then socket, then an offer
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  try {
    // `extractable: false` on the private half. The public half is always extractable,
    // which is what lets us publish it in the descriptor; the private half has no export
    // path at all, so there is no bug in this file that could leak it.
    state.keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify"
    ])) as CryptoKeyPair;
  } catch {
    // Fail closed and say why. Consent that cannot be cryptographically bound to this
    // device is not the consent this product promises, so degrading to an unsigned "I
    // agree" is not an option — it would be the BeyondTrust failure mode with our name on
    // it.
    fatal(
      "This browser cannot create the security key this needs (Ed25519). " +
        "Update your browser, or ask the agent for a different way to help."
    );
    return;
  }
  openSocket();
}

function openSocket(): void {
  const socket = new WebSocket(state.signal);
  state.socket = socket;

  socket.onopen = () => {
    send({ type: "hello", role: "subject", session: state.session, invite: state.invite });
  };
  socket.onmessage = (event) => {
    let message: InboundFrame;
    try {
      message = JSON.parse(String(event.data)) as InboundFrame;
    } catch {
      return;
    }
    void handle(message).catch(fatal);
  };
  socket.onclose = () => {
    state.socket = null;
    if (!state.ended) finish("Connection lost", "The connection to the support session closed.");
  };
  socket.onerror = () => {
    if (!state.ended) fatal("Could not reach the support service.");
  };
}

function send(message: unknown): void {
  if (state.socket && state.socket.readyState === 1) {
    state.socket.send(JSON.stringify(message));
  }
}

async function handle(message: InboundFrame): Promise<void> {
  // Once this surface has said why sharing stopped, nothing the engine sends afterwards may
  // rewrite it. Pressing Stop is local and immediate, so the engine's own `session.ended`
  // always arrives *after* the panel already says "you said no, nothing was shared" — and
  // it was overwriting that with the generic "the session ended", telling the customer
  // less than they already knew and firing a second `ended` at the page.
  if (state.ended) return;
  switch (message.type) {
    case "hello.ok":
      state.current = message.current;
      if (message.state === "minted") {
        send({ type: "bind", version: PROTOCOL, minimum_supported: PROTOCOL });
      } else {
        await requestOffer();
      }
      return;

    case "bound":
      await requestOffer();
      return;

    case "consent.offer":
      renderOffer(message.descriptor, message.theme);
      return;

    case "consented":
      state.consented = true;
      state.current = message.current;
      showLive();
      // The panel has just changed shape. Measure it now rather than trusting a reading
      // taken while it was still the loading placeholder.
      remeasure();
      toParent({ type: "sky.consented", current: message.current });
      return;

    case "capability.changed":
    case "session.live":
      state.current = message.current;
      showLive();
      toParent({ type: "sky.capability", current: message.current });
      return;

    case "presence":
      state.agents = message.agents || 0;
      showLive();
      return;

    case "session.ended":
      finish("Sharing has stopped", reasonText(message.reason));
      toParent({ type: "sky.ended", reason: message.reason });
      return;

    case "error":
      fatal(message.error || "Something went wrong.");
      return;

    default:
      return;
  }
}

async function requestOffer(): Promise<void> {
  const raw = await crypto.subtle.exportKey("raw", state.keys!.publicKey);
  send({
    type: "consent.request",
    session_public_key: toBase64(new Uint8Array(raw)),
    // The origin the BROWSER told us, passed on so the engine records and bounds it. The
    // engine cannot see it: from its side this socket comes from `consent.…`, not from the
    // page being mirrored.
    origin: state.parentOrigin
  });
}

// ---------------------------------------------------------------------------
// Rendering the offer, and signing it
// ---------------------------------------------------------------------------

/**
 * Apply the merchant's theme, keeping only what survives validation.
 *
 * The tokens are written as CSS custom properties on `:root` and nowhere else. That is the
 * whole mechanism: a custom property is a *value*, so a token can change what a colour is
 * and cannot change what an element does. Nothing here concatenates a merchant's string
 * into a stylesheet, and nothing here reads a stylesheet from them — the values arrive as
 * typed data, are re-validated on arrival regardless of who sent them, and a rejected one
 * silently falls back to ours.
 *
 * Re-validated *here* and not only where it was saved, because the dashboard's verdict
 * travels over a wire this frame does not trust. `resolveTheme` is the same function in
 * both places so an operator gets the same answer, but this call is the one that binds.
 */
function applyTheme(theme: ConsentTheme | null | undefined): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.dataset.scheme = resolved.scheme;
  // `color-scheme` follows, so the browser's own form controls and scrollbars match rather
  // than staying light inside a dark card.
  root.style.setProperty(
    "color-scheme",
    resolved.scheme === "auto" ? "light dark" : resolved.scheme
  );
  if (resolved.accent && resolved.accentInk) {
    root.style.setProperty("--accent", resolved.accent);
    root.style.setProperty("--accent-hover", resolved.accent);
    // Chosen, never configured: whichever of black or white the merchant's colour can
    // actually carry. A merchant who could set the label colour could set it to their
    // background.
    root.style.setProperty("--accent-ink", resolved.accentInk);
    root.style.setProperty("--focus", resolved.accent);
    // A colour too close to the card behind it would leave the primary action invisible.
    // The border is derived from the merchant's own accent, so this is not a second colour
    // they get to choose.
    root.style.setProperty("--accent-edge", resolved.accentEdge ?? resolved.accent);
  }
  if (resolved.radius !== null) {
    root.style.setProperty("--radius", `${resolved.radius}px`);
    root.style.setProperty("--radius-control", `${Math.min(resolved.radius, 12)}px`);
  }
  if (resolved.font) {
    root.style.setProperty("--font", resolved.font);
    document.body.style.fontFamily = `${resolved.font}, system-ui, sans-serif`;
  }
  for (const { token, reason } of resolved.rejected) {
    // Logged rather than swallowed. It is the merchant's own console during integration,
    // and a setting that does nothing with no explanation is how a theme gets debugged by
    // guessing.
    console.warn(`[sky-remote] consent theme: \`${token}\` was not applied — ${reason}`);
  }
}

function renderOffer(descriptor: ConsentDescriptor, theme?: ConsentTheme | null): void {
  applyTheme(theme);
  state.descriptor = descriptor;
  const identity = descriptor.display_identity || {};

  ui.who.textContent = identity.legal_name || "A support agent";
  if (identity.logo_uri) {
    ui.logo.src = identity.logo_uri;
    ui.logo.hidden = false;
  }
  // The origin from the DESCRIPTOR, which is the value about to be signed — not the one we
  // rendered optimistically at init. If the engine echoed back something else, the
  // customer sees the difference before they agree rather than after.
  ui.origin.textContent = descriptor.origin || "";

  // **The heading makes no claim about what is being permitted, and that is deliberate.**
  //
  // It used to branch on `descriptor.ceiling.access` — the same input `scope_text` branches on
  // — and so was a second, independent statement of the terms, written in TypeScript, outside
  // the descriptor, outside the digest this surface recomputes, and outside the `consent.text`
  // audit body that D-09 requires to carry "the exact scope text that was displayed". It had
  // already drifted: it said "a support agent" where the signed body names the merchant.
  //
  // `core::consent::scope_text` says "there is one of these", and records that a second
  // implementation in TypeScript had previously grown and diverged in six ways. Rather than
  // recreate that, the heading now only says what kind of screen this is. Every term the
  // customer agrees to is in `scope_text` below it — signed, recorded, and reproducible from
  // the audit chain.
  ui.askTitle.textContent = "A support agent is asking for access";
  ui.scope.textContent = descriptor.scope_text || "";
  ui.verify.textContent =
    "This panel is served by us, not by the site you are on. Check the address above " +
    "matches the site in your browser's address bar. You can stop at any time.";

  show("ask");
  shape("ask");
  announce("A support agent is asking to share this page. Read the terms and choose Allow or Not now.");
  // Focus the heading rather than a button. The customer should read before the keyboard
  // lands on an affirmative control, and a default focus on Allow is one Enter away from
  // consent nobody read.
  focusFirst(ui.askTitle);
}

ui.allow.addEventListener("click", () => {
  ui.allow.disabled = true;
  ui.deny.disabled = true;
  accept().catch((e: unknown) => {
    ui.allow.disabled = false;
    ui.deny.disabled = false;
    fatal(e instanceof Error ? e.message : String(e));
  });
});

ui.deny.addEventListener("click", () => {
  // A refusal ends the session rather than leaving it minted and waiting. The state
  // machine has no "declined" state; revocation is the transition that means "not this".
  revoke("You said no. Nothing was shared.");
});

async function accept(): Promise<void> {
  // Recomputed here, from the fields rendered above. This is the line that makes a
  // compromised engine unable to collect a signature over terms the customer never saw.
  const digest = await canonicalDigest(state.descriptor!);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    state.keys!.privateKey,
    digest as BufferSource
  );
  send({ type: "consent", subject_signature: toBase64(new Uint8Array(signature)) });
}

// ---------------------------------------------------------------------------
// Live: the indicator, the narrowing control, the stop control
// ---------------------------------------------------------------------------

let lastAnnouncedStreaming: boolean | null = null;

/** What the indicator says, in one place, for both the visible label and the announcement. */
function liveWording(streaming: boolean, control: boolean): { label: string; announcement: string } {
  if (!streaming) {
    return {
      label: "Paused — they cannot see this page",
      announcement: "Sharing paused. The agent cannot see this page."
    };
  }
  if (control) {
    return {
      label: "Sharing — they can click and type",
      announcement: "Sharing started. The agent can see this page and can click and type."
    };
  }
  return {
    label: "Sharing this page",
    announcement: "Sharing started. The agent can see this page."
  };
}

function showLive(): void {
  if (!state.consented || state.ended) return;
  const surfaces = state.current?.surfaces ?? [];
  const control = state.current?.access === "control";
  const streaming = surfaces.length > 0;

  // The label and the screen-reader announcement below are the same three-way decision, and
  // they were computed separately twenty lines apart over the same two booleans.
  const wording = liveWording(streaming, control);
  ui.liveLabel.textContent = wording.label;
  ui.dot.dataset.watching = String(streaming);
  // Pluralised, because more than one agent on a session is a supported state — the engine
  // counts them and a second console attaching is what drives the re-snapshot — and "2 agent
  // connected" on the one surface a customer reads to decide whether to trust this reads as a
  // bug in the thing asking for their trust.
  ui.liveDetail.textContent = state.agents
    ? state.agents === 1
      ? "1 agent connected"
      : `${state.agents} agents connected`
    : "Waiting for the agent to connect";

  // Narrowing is the customer's and needs no agent agreement. Shown only when there is
  // something to narrow.
  ui.viewOnly.hidden = !control;
  show("live");
  shape(narrowedByVisibility ? "indicator-alert" : "indicator");

  if (lastAnnouncedStreaming !== streaming) {
    lastAnnouncedStreaming = streaming;
    announce(wording.announcement);
  }
}

ui.viewOnly.addEventListener("click", () => {
  // The current vector with one field changed, and every other field echoed back
  // untouched — including `expires_at`. Recomputing that from the clock would push the
  // deadline past the ceiling pinned at consent, and the engine refuses it: a session
  // cannot extend its own life by narrowing its capability.
  if (!state.current) return;
  send({ type: "capability.set", current: { ...state.current, access: "view" } });
  ui.viewOnly.disabled = true;
  window.setTimeout(() => {
    ui.viewOnly.disabled = false;
  }, 500);
});

ui.stop.addEventListener("click", () => revoke("The agent can no longer see this page."));
ui.close.addEventListener("click", () => shape("gone"));

function revoke(detail: string): void {
  // Local and immediate: the UI changes now, and the frame does not wait for the engine to
  // agree. `docs/03-trust-model.md` obligation 3 — pressing stop is not a request.
  state.ended = true;
  send({ type: "revoke" });
  finish("Sharing has stopped", detail);
  toParent({ type: "sky.ended", reason: "revoked_by_customer" });
  window.setTimeout(() => {
    if (state.socket) {
      try {
        state.socket.close();
      } catch {
        /* already closing */
      }
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// The self-checks, which fail closed
// ---------------------------------------------------------------------------

/**
 * Is this surface actually on the customer's screen?
 *
 * `IntersectionObserver` inside a cross-origin iframe measures against the TOP-LEVEL
 * viewport, clipped by every intermediate ancestor. That makes it the one geometric fact
 * the embedding page cannot fake from outside: it can move us off-screen, scroll us out of
 * view, or clip us with `overflow`, and this reports it.
 *
 * What it cannot see, honestly stated: an element painted on top of us, or an ancestor
 * with `opacity: 0.01`. Both are in the parent's DOM, and both are what the SDK's own
 * check exists to catch. Two layers, neither sufficient alone.
 */
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      state.intersecting = entry.isIntersecting && entry.intersectionRatio >= 0.9;
      evaluateVisibility("clipped or scrolled out of view");
    }
  },
  { threshold: [0, 0.5, 0.9, 1] }
);
observer.observe(document.body);

/** Re-observe, to get a fresh reading rather than waiting for the next change. Needed
 *  because a change of shape moves this frame, and without a nudge a stale answer would
 *  pause a session that is perfectly visible. */
function remeasure(): void {
  observer.unobserve(document.body);
  observer.observe(document.body);
}

document.addEventListener("visibilitychange", () => {
  // A hidden tab is not "the customer can see the indicator". `docs/03` refuse-list item 2.
  state.tabVisible = document.visibilityState === "visible";
  if (state.tabVisible) remeasure();
  evaluateVisibility("this tab is not in front");
});

/**
 * Sharing is paused because this panel is not fully visible.
 *
 * **The flag is the state and the DOM follows it.** `ui.warn.hidden` used to be the second
 * copy: written beside this flag in two places, written *without* it in `finish()`, and read
 * instead of it by `showLive()` to choose the panel's shape. Which shape the panel was in was
 * therefore a property of a `hidden` attribute whose writers were a hundred lines apart.
 */
let narrowedByVisibility = false;
let savedCapability: Capability | null = null;

/** Show or hide the warning banner from the one flag that decides it. */
function syncWarning(): void {
  ui.warn.hidden = !narrowedByVisibility;
}

function evaluateVisibility(why: string): void {
  if (!state.consented || state.ended) return;
  const ok = state.intersecting && state.tabVisible && state.parentSaysVisible;

  if (!ok && !narrowedByVisibility) {
    narrowedByVisibility = true;
    // **Only ever remember a capability that is actually streaming.**
    //
    // `state.current` is the ENGINE's echo, not what this frame last sent — it is only
    // assigned from `capability.changed`. So a panel that flaps faster than the round trip
    // re-narrows while the echo of the *previous* narrow is the newest thing this frame has
    // seen, and the naive `savedCapability = state.current` then remembers the narrowed
    // capability as the thing to restore. Every restore after that restores nothing, the
    // session is stranded with no surface, and the customer's page never streams again —
    // with the panel visible, the customer having done nothing, and no error anywhere.
    //
    // Seen in production: a chain of `capability.changed` events reading `[] -> []` several
    // times a second, for the rest of the session, and an agent console stuck on "waiting
    // for the customer's page" behind them.
    //
    // Keeping the last streaming capability instead is what makes the restore idempotent:
    // whatever the flap does, the thing we go back to is the last state that actually shared
    // something. It is deliberately NOT the ceiling — the customer may have narrowed to view
    // on purpose, and restoring to the ceiling would widen what they chose.
    if (state.current && state.current.surfaces.length > 0) savedCapability = state.current;
    syncWarning();
    ui.warn.textContent =
      `Sharing paused: this panel is not fully visible (${why}). ` +
      "It resumes when the panel is back on screen.";
    announce("Sharing paused because this panel is not fully visible.");
    // Narrow to nothing rather than end. The customer has not asked to stop, and ending
    // a session because a page scrolled would be its own kind of broken — but nothing
    // streams while the stop control is not reachable.
    //
    // Not sent when there is nothing to narrow. A `capability.set` that changes nothing is
    // still a frame the engine records, and a flapping panel turned that into an append-only
    // chain filling with `[] -> []` at several rows a second.
    if (state.current && state.current.surfaces.length > 0) {
      send({ type: "capability.set", current: { ...state.current, surfaces: [] } });
    }
    shape("indicator-alert");
    return;
  }
  if (ok && narrowedByVisibility) {
    narrowedByVisibility = false;
    syncWarning();
    // Restore only if it would actually change something, and **keep** the saved capability
    // rather than clearing it. A later narrow that cannot capture a streaming capability —
    // because the echo has not caught up — then still has the last good one to come back to,
    // which is the property that makes a flap survivable rather than terminal.
    if (savedCapability && (state.current?.surfaces.length ?? 0) === 0) {
      send({ type: "capability.set", current: savedCapability });
    }
    shape("indicator");
  }
}

// ---------------------------------------------------------------------------
// Keyboard, focus and announcements
// ---------------------------------------------------------------------------

/**
 * A focus trap inside the card.
 *
 * The SDK's host is a real `<dialog>` opened with `showModal()`, so the browser has
 * already made the embedding page inert — but focus inside this frame still has to cycle
 * rather than escaping into the browser's own chrome on the first Tab.
 */
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !state.consented && !state.ended && !ui.ask.hidden) {
    // The safe answer to a modal a customer wants gone. Escape can only ever decline.
    event.preventDefault();
    revoke("You said no. Nothing was shared.");
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...document.querySelectorAll<HTMLElement>("button:not([hidden]):not(:disabled)")]
    .filter((node) => node.offsetParent !== null || node === document.activeElement);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

function focusFirst(node: HTMLElement): void {
  node.setAttribute("tabindex", "-1");
  window.setTimeout(() => node.focus({ preventScroll: true }), 0);
}

function announce(text: string): void {
  // Cleared first, so an identical message is re-announced rather than swallowed as "no
  // change" by the assistive technology.
  ui.announce.textContent = "";
  window.setTimeout(() => {
    ui.announce.textContent = text;
  }, 60);
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Show one section and its actions.
 *
 * One argument, because the two always co-varied and nothing stopped `show(ui.ask,
 * ui.liveActions)` from compiling. The pairing lives in one table instead.
 */
function show(which: "ask" | "live" | "over"): void {
  const section = { ask: ui.ask, live: ui.live, over: ui.over }[which];
  const actions = { ask: ui.askActions, live: ui.liveActions, over: ui.overActions }[which];
  for (const s of [ui.loading, ui.ask, ui.live, ui.over]) s.hidden = s !== section;
  for (const f of [ui.askActions, ui.liveActions, ui.overActions]) f.hidden = f !== actions;
}

/**
 * The last thing the customer sees, and it is this frame's to show.
 *
 * The SDK stops streaming the instant a session ends and leaves the surface standing until
 * it says it is done. Both ends tearing down at once meant a customer who pressed "Not now"
 * watched the panel vanish with no confirmation that nothing had been shared.
 *
 * `modal: false` — a session that ended is a notice, not a question, and a full-screen
 * modal over a page the customer is trying to use again would be its own kind of rude. A
 * `fatal` before consent stays modal, because it is an answer to a question they were just
 * asked and it has something they need to read.
 */
function finish(title: string, detail: string, options: { modal?: boolean } = {}): void {
  const modal = options.modal ?? false;
  state.ended = true;
  ui.overTitle.textContent = title;
  ui.overDetail.textContent = detail || "";
  narrowedByVisibility = false;
  syncWarning();
  show("over");
  announce(`${title}. ${detail}`);
  shape(modal ? "ask" : "indicator-alert");
  if (!modal) window.setTimeout(() => shape("gone"), 6000);
}

function fatal(message: unknown): void {
  finish("Cannot share this page", message instanceof Error ? message.message : String(message), {
    modal: true
  });
}

function reasonText(reason: EndReason): string {
  switch (reason) {
    case "revoked_by_customer":
      return "You stopped it.";
    case "terminated_by_merchant":
      return "The support team ended the session.";
    case "expired_absolute":
    case "expired_max_duration":
      return "The session reached its time limit.";
    default:
      return "The session ended.";
  }
}
