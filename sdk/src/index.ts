/*!
 * sky-remote co-browse SDK.
 *
 * Read `README.md` for the integration contract and `../PROTOCOL.md` for the wire format.
 *
 * Four rules this package exists to keep:
 *
 *  1. ZERO RUNTIME DEPENDENCIES IN THE SHIPPED BUNDLE. Not few — zero. Nothing is
 *     imported at run time, nothing is fetched, there is no `eval`, no `new Function`, no
 *     dynamic script insertion and no remote configuration that can change behaviour.
 *     There *is* a build step, and the published package carries an npm provenance
 *     attestation binding the tarball to the commit and workflow that produced it, so "what
 *     runs in your page came from this source" stays checkable by someone other than us.
 *
 *  2. NOTHING TOUCHES THE DEVICE UNTIL THE CUSTOMER ASKS. On load this module defines an
 *     API and does nothing else: no connection, no cookie, no storage, no identifier read.
 *     The ePrivacy consequence is the point — a merchant that has to declare us in their
 *     consent-management platform has to make integration a legal review instead of a
 *     script tag. There is no `localStorage`, `sessionStorage`, `document.cookie` or
 *     `indexedDB` anywhere in this package.
 *
 *  3. SENSITIVE VALUES ARE PROTECTED BY DEFAULT, AND CONFIGURATION FAILS CLOSED. Card
 *     numbers, CVVs, passwords, one-time codes and bank details are masked and untypeable
 *     with no configuration, detected by `privacy.ts` rather than by asking the merchant to
 *     enumerate their own secrets. Page text and labels stay legible so the agent can read
 *     the page they were called about; `privacy: "strict"` restores the allowlist posture for
 *     deployments that need it. A malformed selector or an unknown tier stops the stream
 *     rather than being skipped (D-19).
 *
 *  4. THE SDK OWNS NO VISIBLE UI EXCEPT THE CONSENT SURFACE. The launcher, the "get help"
 *     button and every piece of chrome around it belong to the integrator, who knows what
 *     their site looks like. What cannot be theirs is the consent panel: it is on our
 *     origin, holds a key their page cannot reach, and is the one thing in this product
 *     that must not be styleable, skinnable or reproducible by the page it appears in.
 */

import {
  PROTOCOL_VERSION,
  type Capability,
  type EndReason,
  type FrameToPage,
  type InboundFrame,
  type InputEvent_,
  type OutboundFrame
} from "../../protocol/src/index.js";
import { applyOptions, initialConfig, type ResolvedConfig, type SkyOptions } from "./config.js";
import { ConsentHost, type GeometryProblem } from "./consent-host.js";
import { Chokepoint } from "./input.js";
import { Presence } from "./presence.js";
import { closeQuietly } from "./dom.js";
import { Serializer } from "./serializer.js";
import { MirrorStream } from "./stream.js";

/**
 * The version, injected at build time from `packages/package.json`.
 *
 * Not a literal. It was one, and it drifted: the bundle shipped as 2.5.1 while this file still
 * said 2.5.0, so `Sky.version` reported a build that was not the one serving. `build.mjs`
 * injects `__SKY_VERSION__` from `sdk/package.json`, which is the only place a version is
 * written — `npm version` there is what moves it.
 */
declare const __SKY_VERSION__: string;

export const VERSION = __SKY_VERSION__;
export type { SkyOptions } from "./config.js";
export type { Capability } from "../../protocol/src/index.js";

/**
 * Where the session is, in one word.
 *
 * Exposed because an integrator's own UI has to render it — a launcher that cannot tell
 * "waiting in the queue" from "nobody answered" is a launcher that shows a spinner
 * forever.
 */
export type SkyState =
  | "idle"
  | "requesting"
  | "queued"
  | "invited"
  | "live"
  | "paused"
  | "ended";

export interface SkyEvents {
  /** The state word changed. Every other event is a detail of one of these. */
  state: { state: SkyState; previous: SkyState };
  requesting: Record<string, never>;
  queued: { requestId: string; workspaceId: string; legalName: string; expiresIn: number };
  cancelled: Record<string, never>;
  invited: { session: string };
  consented: { current: Capability };
  capability: { current: Capability };
  /** The panel was covered, faded or scrolled away and streaming stopped locally. */
  obscured: { reason: GeometryProblem | null };
  visible: Record<string, never>;
  ended: { reason: EndReason };
  error: { where: string; error?: string };
  /** Fidelity was reduced for a reason worth telling the integrator about — an
   *  unreadable third-party stylesheet, most often. */
  degraded: { what: string };
}

type Listener<K extends keyof SkyEvents> = (detail: SkyEvents[K]) => void;

export interface SkyApi {
  readonly version: string;
  readonly protocol: number;
  readonly state: SkyState;
  readonly active: boolean;
  configure(options?: SkyOptions): ResolvedConfig;
  requestAssistance(options?: SkyOptions & { note?: string }): void;
  cancelRequest(): void;
  present(invite: string, session: string, options?: SkyOptions): void;
  stop(): void;
  on<K extends keyof SkyEvents>(event: K, fn: Listener<K>): SkyApi;
  off<K extends keyof SkyEvents>(event: K, fn: Listener<K>): SkyApi;
}

export function createSky(initial?: SkyOptions): SkyApi {
  const config: ResolvedConfig = applyOptions(initialConfig(), initial);
  const listeners = new Map<string, Set<(detail: unknown) => void>>();

  let state: SkyState = "idle";
  let session: string | null = null;
  let invite: string | null = null;
  let socket: WebSocket | null = null;
  let visitorSocket: WebSocket | null = null;
  let current: Capability | null = null;
  let host: ConsentHost | null = null;
  let lastHref = typeof location !== "undefined" ? location.href : "";
  /** How many agents the engine last said were attached, so an increase can be noticed. */
  let agentsAttached = 0;
  let navigationTimer: number | null = null;
  let surfaceTimer: number | null = null;

  const serializer = new Serializer({
    config,
    onDegraded: (what) => emit("degraded", { what })
  });
  const chokepoint = new Chokepoint({
    serializer,
    consentFrame: () => host?.element ?? null
  });
  const presence = new Presence({
    serializer,
    send: (cursor) => sendMirror({ type: "presence.cursor", cursor })
  });
  const stream = new MirrorStream(
    serializer,
    (frame) => sendMirror(frame),
    // Same channel as the serializer's own fidelity warnings: this is one more way the mirror
    // is not going to be what the integrator expects, and it belongs in the same place they are
    // already told to look.
    (what) => emit("degraded", { what })
  );

  // -- events --------------------------------------------------------------

  function emit<K extends keyof SkyEvents>(event: K, detail: SkyEvents[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(detail);
      } catch (e) {
        warn(`listener for ${event} threw`, e);
      }
    }
  }

  function setState(next: SkyState): void {
    if (next === state) return;
    const previous = state;
    state = next;
    emit("state", { state: next, previous });
  }

  function warn(...args: unknown[]): void {
    if (typeof console !== "undefined" && console.warn) console.warn("[sky-remote]", ...args);
  }

  // -- the mirror socket ---------------------------------------------------

  function sendMirror(frame: OutboundFrame | { serialized: string }): void {
    if (!socket || socket.readyState !== 1) return;
    socket.send("serialized" in frame ? frame.serialized : JSON.stringify(frame));
  }

  function openMirrorChannel(): void {
    if (socket) return;
    const next = new WebSocket(config.signal);
    socket = next;

    next.onopen = () => {
      next.send(JSON.stringify({ type: "hello", role: "subject", session, invite }));
    };
    next.onmessage = (e) => {
      let message: InboundFrame;
      try {
        message = JSON.parse(String(e.data)) as InboundFrame;
      } catch {
        return;
      }
      handleMirrorFrame(next, message);
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      stream.stop();
      // D-27, and this path was missed: presence has to stop with the stream here too. A
      // closed socket leaves `sendMirror` silently dropping frames, so nothing would have been
      // transmitted — but the overlay would have stayed drawn on the customer's page and the
      // pointer listeners would have kept running, which is our UI asserting a live session
      // over a dead one.
      presence.stop();
    };
    next.onerror = () => emit("error", { where: "mirror-socket" });
  }

  function handleMirrorFrame(sock: WebSocket, message: InboundFrame): void {
    switch (message.type) {
      // Three frames, one meaning: "this is what the customer currently permits." They arrived
      // as two identical arms twenty lines apart.
      case "hello.ok":
      case "capability.changed":
      case "session.live":
        current = message.current;
        applyCapability();
        return;
      case "input": {
        const refusal = chokepoint.dispatch(message.event as InputEvent_);
        if (refusal) {
          // The agent is told why, so a dead region reads as a rule rather than as a bug
          // (docs/03 §2c). The engine records the attempt; this end records nothing,
          // because an append-only chain written from the customer's page is a chain the
          // customer's page can flood.
          sock.send(JSON.stringify({ type: "mirror", op: "refused", data: { refusal } }));
        }
        return;
      }
      case "presence.cursor":
        // Only the agent's. The engine routes by role and never echoes a peer its own cursor,
        // so this is a second layer rather than the only one — and the check is cheap enough
        // that not having it would be the odd choice.
        if (message.role !== "agent") return;
        presence.show(message.cursor, { merchant: message.merchant, who: message.who });
        return;
      case "presence":
        // **An agent that arrives after the first snapshot gets an empty page.**
        //
        // The stream is one snapshot followed by mutations, and the engine relays frames
        // verbatim and keeps none of them — deliberately, because a relay that cached DOM
        // would be a relay that understood it. So the snapshot exists exactly once, at the
        // moment streaming starts. An agent who attaches later, or whose socket reconnected,
        // or who reloaded the console, receives only the mutations that follow: they land on
        // an empty document and the console shows a white rectangle for the rest of the
        // session. Input still works, because that is dispatched by coordinate against the
        // live DOM, which is what makes the failure look like a rendering bug rather than a
        // missing frame.
        //
        // `presence` already carries the agent count, so no new frame is needed. A count that
        // went up means somebody is looking who has not been sent a page yet.
        if (message.agents > agentsAttached) stream.resync();
        agentsAttached = message.agents;
        return;
      case "session.ended":
        emit("ended", { reason: message.reason });
        endSession();
        return;
      default:
        return;
    }
  }

  /** Start or stop streaming to match what the customer currently permits. */
  function applyCapability(): void {
    const surfaces = current?.surfaces ?? [];
    const shouldStream = surfaces.length > 0 && (host?.geometryOk ?? true);
    // D-27: presence starts and stops with the stream, from the *same* decision rather than
    // from a second one that has to agree with it. The failure this prevents has happened here
    // before — the navigation watcher outlived the stream it served — and for presence the
    // consequence is worse than a stale URL: a customer who pauses sharing and keeps browsing,
    // while their cursor still streams, is being watched after pressing the control that says
    // they are not.
    // `start`/`stop` are both idempotent — `start` returns early when running, `stop` clears
    // state that is already clear — so the `active` guards were restating what they already do.
    if (shouldStream) presence.start();
    else presence.stop();

    if (shouldStream && !stream.active) {
      // `lastHref` is re-read at the moment streaming resumes, not left where the watcher put
      // it. A pause is exactly when a customer navigates — they were told the agent cannot see
      // the page — and `stream.start()` below sends a fresh snapshot of wherever they now are,
      // so the baseline has to be that page. Leaving it stale would arm the watcher to fire a
      // redundant resync one tick later.
      lastHref = location.href;
      stream.start();
      watchNavigation();
    } else if (!shouldStream && stream.active) {
      stream.stop();
      // Stopped with the stream it exists to serve. It used to outlive it: a paused session
      // kept a 400 ms interval running for the length of the pause, and — worse than the timer
      // — it kept advancing `lastHref` while nothing was streaming. A customer who navigated
      // while paused therefore resumed with the watcher already satisfied, so the resync never
      // fired and the agent went on looking at the route the customer had left.
      stopWatchingNavigation();
    }

    // The state follows from `shouldStream` alone, so it is set once rather than in four arms
    // that between them named `"live"` twice and `"paused"` twice. The `session` guard keeps a
    // teardown from announcing `"paused"` after the session is gone.
    if (shouldStream) setState("live");
    else if (session) setState("paused");
  }

  /**
   * A single-page application changes its URL without loading anything.
   *
   * The DOM changes are caught by the mutation stream, but a route change replaces most of
   * the document at once and often loads a code-split stylesheet with it. Re-snapshotting
   * is the cheap, correct answer: it happens once per navigation, and it means the agent
   * is never looking at a page assembled half from one route and half from another.
   */
  function watchNavigation(): void {
    if (navigationTimer !== null) return;
    navigationTimer = window.setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      stream.resync();
    }, 400);
  }

  function stopWatchingNavigation(): void {
    if (navigationTimer !== null) window.clearInterval(navigationTimer);
    navigationTimer = null;
  }

  // -- the consent surface -------------------------------------------------

  function openConsent(): void {
    host = new ConsentHost(config.consent, {
      onMessage: onConsentMessage,
      onGone: removeSurface,
      onGeometry: (ok, reason) => {
        if (!ok) {
          // Local and immediate. The frame is told as well, and it is the frame that
          // narrows the capability on its own socket — but the stream stops here first,
          // without waiting for a round trip.
          stream.stop();
          // And presence with it. The consent surface failing closed is exactly the case
          // where a cursor must not keep moving: the customer cannot see the panel that
          // tells them a session is live, so nothing of ours may go on asserting one.
          presence.stop();
          setState("paused");
          emit("obscured", { reason });
        } else {
          applyCapability();
          emit("visible", {});
        }
      }
    });
    host.open(session!, invite!, config.signal, VERSION, config.locale);
  }

  function onConsentMessage(message: FrameToPage): void {
    switch (message.type) {
      case "sky.ready":
        host?.post({
          type: "sky.init",
          session: session!,
          invite: invite!,
          signal: config.signal,
          version: VERSION,
          locale: config.locale
        });
        return;
      case "sky.consented":
        current = message.current;
        emit("consented", { current: message.current });
        openMirrorChannel();
        return;
      case "sky.capability":
        current = message.current;
        emit("capability", { current: message.current });
        applyCapability();
        return;
      case "sky.ended":
        emit("ended", { reason: message.reason });
        endSession();
        return;
      default:
        return;
    }
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Stop everything that touches the customer's page, and leave the surface standing.
   *
   * The consent frame owns its own goodbye — "you said no, nothing was shared" — and a
   * teardown that removed the iframe the moment the session ended took that message away
   * with it. What must not survive this call is the stream, the sockets or the node map.
   */
  function stopSession(next: SkyState): void {
    stream.stop();
    // Removes the overlay rather than hiding it: nothing of ours may outlive the session on a
    // customer's page, and a hidden element is one CSS rule away from being visible again.
    presence.stop();
    stopWatchingNavigation();
    serializer.reset();
    if (socket) {
      closeQuietly(socket);
      socket = null;
    }
    if (visitorSocket) {
      closeQuietly(visitorSocket);
      visitorSocket = null;
    }
    session = null;
    invite = null;
    current = null;
    setState(next);
  }

  function removeSurface(): void {
    if (surfaceTimer !== null) window.clearTimeout(surfaceTimer);
    surfaceTimer = null;
    host?.close();
    host = null;
  }

  function endSession(): void {
    stopSession("ended");
    // A backstop, in case the frame never says it is finished. A panel left on a
    // customer's page after the session is over is litter, not safety.
    if (surfaceTimer === null) surfaceTimer = window.setTimeout(removeSurface, 15_000);
  }

  const api: SkyApi = {
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    get state() {
      return state;
    },
    get active() {
      return session !== null;
    },

    configure(options?: SkyOptions) {
      return applyOptions(config, options);
    },

    /**
     * The no-backend path: the customer asks, an agent answers.
     *
     * The initiation inversion (D-01) is intact and worth being precise about — this
     * creates no session. It puts the customer in an agent's queue, and only an
     * authenticated agent inside a merchant console can turn that into a session. The
     * customer gets to raise their hand; they cannot start anything.
     */
    requestAssistance(options) {
      if (session || visitorSocket) {
        throw new Error("sky-remote: assistance has already been requested");
      }
      // Options are applied first here — unlike `present()`, whose arguments can be checked
      // without them — because `workspace` may arrive in this very call. The check below reads
      // the resolved value for that reason, and it is the last thing that can refuse.
      applyOptions(config, options);
      if (!config.workspaceKey) {
        throw new Error("sky-remote: no workspace key (data-workspace, or configure({ workspace }))");
      }

      const sock = new WebSocket(config.signal);
      visitorSocket = sock;
      setState("requesting");
      emit("requesting", {});

      sock.onopen = () => {
        sock.send(
          JSON.stringify({
            type: "hello",
            role: "visitor",
            key: config.workspaceKey,
            page: location.pathname,
            note: options?.note ? String(options.note) : null
          })
        );
      };
      sock.onmessage = (e) => {
        let message: InboundFrame;
        try {
          message = JSON.parse(String(e.data)) as InboundFrame;
        } catch {
          return;
        }
        if (message.type === "request.queued") {
          setState("queued");
          emit("queued", {
            requestId: message.request_id,
            workspaceId: message.workspace_id,
            legalName: message.legal_name,
            expiresIn: message.expires_in
          });
        } else if (message.type === "invite") {
          // Answered. Reconnect as the subject — the same code path an
          // integrator-delivered invite takes, so there is one attach path rather than
          // two.
          visitorSocket = null;
          closeQuietly(sock);
          api.present(message.invite, message.session);
        } else if (message.type === "error") {
          emit("error", { where: "request", error: message.error });
        }
      };
      sock.onclose = () => {
        if (visitorSocket === sock) {
          visitorSocket = null;
          if (state === "requesting" || state === "queued") {
            setState("idle");
            emit("cancelled", {});
          }
        }
      };
    },

    /** The customer changed their mind before anyone answered. */
    cancelRequest() {
      if (!visitorSocket) return;
      const sock = visitorSocket;
      visitorSocket = null;
      closeQuietly(sock);
      setState("idle");
      emit("cancelled", {});
    },

    /**
     * The integrator path (D-21, piggyback): the invite arrived over the merchant's own
     * channel.
     *
     * This is the first moment anything is opened. Until now this module has done nothing
     * but exist.
     */
    present(inviteToken, sessionId, options) {
      if (session) throw new Error("sky-remote: a session is already open");
      // Arguments before configuration. `applyOptions` mutates the resolved config in place, so
      // validating afterwards left a rejected call having already changed the tier and the
      // selector lists — the next `present()` would run under configuration from a call that
      // threw.
      if (!inviteToken || !sessionId) {
        throw new Error("sky-remote: present(inviteToken, sessionId) needs both");
      }
      // A queued request that nobody has answered is abandoned rather than left running.
      // `requestAssistance()` clears `visitorSocket` itself before calling this on the invite
      // it just received, so this only fires on the integrator path — where an invite arriving
      // over the merchant's own channel while the customer is still in the queue is a real
      // sequence, and used to leave a socket nothing would ever close.
      if (visitorSocket) {
        const stale = visitorSocket;
        visitorSocket = null;
        closeQuietly(stale);
      }
      applyOptions(config, options);
      session = String(sessionId);
      invite = String(inviteToken);
      lastHref = location.href;
      openConsent();
      setState("invited");
      emit("invited", { session });
    },

    stop() {
      // The customer's stop control lives in the consent frame, where it cannot be
      // suppressed by this code. This is the merchant's page closing its own widget,
      // which is a different thing: it asks the frame to revoke, so revocation still
      // travels the frame's own socket.
      host?.post({ type: "sky.stop" });
      window.setTimeout(() => {
        stopSession("ended");
        removeSurface();
      }, 250);
    },

    on(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn as (detail: unknown) => void);
      return api;
    },

    off(event, fn) {
      listeners.get(event)?.delete(fn as (detail: unknown) => void);
      return api;
    }
  };

  return api;
}
