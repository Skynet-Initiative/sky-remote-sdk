/**
 * The signalling frames, typed once.
 *
 * `PROTOCOL.md` is the prose form and `crates/engine/src/signal.rs` is the authority. The
 * types here exist so that the two browser peers cannot disagree with each other about a
 * field name, which is the drift the engine cannot see: it relays mirror frames verbatim
 * and never parses them.
 */

import type { Capability, ConsentDescriptor } from "./canonical.js";
import type { MirrorMutation, MirrorSnapshot, Refusal } from "./mirror.js";
import type { ConsentTheme } from "./theme.js";

export const PROTOCOL_VERSION = 1;

/**
 * How often a presence cursor may be sent, per peer, in milliseconds.
 *
 * Both ends throttle to this and the engine does not police it — a peer that ignores it is
 * spending its own socket, and the frame is four numbers. What the shared constant buys is that
 * the two implementations cannot drift into sending at different rates and blaming the network.
 *
 * 50 ms — 20 Hz — sits between the two published defaults from the multiplayer infrastructure
 * vendors: Liveblocks throttles at 100 ms by default over a 16–1000 ms range, Ably batches
 * cursors at 25 ms. Pusher caps client events at 10 Hz, which is the floor of what reads as
 * live. Ours is a support session with one cursor per side rather than a design tool with
 * twenty, so the fan-out that motivates the tighter numbers does not apply, and 20 Hz is
 * comfortably smooth once the receiver interpolates.
 *
 * The receiver **does** interpolate — a CSS transition of exactly this duration, linear. That
 * is the cheap half of the answer and the one that matters: at 20 Hz an uninterpolated cursor
 * visibly steps, and a linear transition over the send interval makes it continuous without
 * adding a frame of latency beyond the interval itself. Easing would look smoother in
 * isolation and lie about direction, which is the one thing a pointer must not do.
 */
export const PRESENCE_THROTTLE_MS = 50;

/**
 * How long a cursor survives without an update before the receiver hides it.
 *
 * A peer whose tab is backgrounded stops firing pointer events and stops sending, so without
 * this the last position would sit on the page indefinitely, pointing at something nobody is
 * pointing at. Yjs's awareness protocol solves the same problem with a 30-second timeout; a
 * cursor needs to be far tighter than a presence roster because it makes a claim about *now*.
 *
 * Deliberately several times `PRESENCE_THROTTLE_MS`, so ordinary jitter and a dropped frame
 * never flicker the cursor. A peer that has genuinely gone still stops sending, which is the
 * common case and is what the explicit null is for; this is the backstop for the case where
 * the socket went quiet without saying so.
 */
export const PRESENCE_IDLE_MS = 2000;

export type Role = "visitor" | "subject" | "agent";

export type SessionState = "minted" | "bound" | "consented" | "live" | "ended";

export type EndReason =
  | "revoked_by_customer"
  | "terminated_by_merchant"
  | "expired_absolute"
  | "expired_max_duration"
  | string;

// -- what a browser sends ---------------------------------------------------

export type OutboundFrame =
  | { type: "hello"; role: "visitor"; key: string; page: string; note: string | null }
  | { type: "hello"; role: "subject"; session: string; invite: string }
  | { type: "hello"; role: "agent"; session: string; token: string }
  | { type: "bind"; version: number; minimum_supported: number }
  | { type: "consent.request"; session_public_key: string; origin: string | null }
  | { type: "consent"; subject_signature: string }
  | { type: "capability.set"; current: Capability }
  | { type: "revoke" }
  | { type: "mirror"; op: "snapshot"; data: MirrorSnapshot; v: number }
  | { type: "mirror"; op: "mutate"; data: MirrorMutation }
  | { type: "mirror"; op: "scroll"; data: { id: number; x: number; y: number } }
  | { type: "mirror"; op: "viewport"; data: { w: number; h: number } }
  | { type: "mirror"; op: "refused"; data: { refusal: Refusal } }
  | { type: "input"; event: InputEvent_ }
  /** Where this peer is pointing. Sent by either side; relayed to the other. D-23. */
  | { type: "presence.cursor"; cursor: PresenceCursor }
  | { type: "ping" };

/** Named `InputEvent_` because `InputEvent` is a DOM global and shadowing it in a file
 *  that also touches the DOM is how a typo becomes a runtime error. */
export type InputEvent_ =
  | { kind: "pointer"; x: number; y: number; button: PointerButton; action: "move" | "down" | "up" }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "key"; code: string; action: "down" | "up" };

export type PointerButton = "primary" | "secondary" | "middle" | "none";

/**
 * Where a participant is pointing. **Not an input event** — D-23.
 *
 * The shape is the argument. There is no button, no action and no key: this carries a position
 * and an identity and nothing that could be performed. The SDK renders it into an element it
 * owns and the console renders it over the mirror; neither end has a branch in which one of
 * these reaches `dispatchEvent`. That is the same structural claim `InputEvent_` makes by
 * having no variant that could grow into "execute", and it is why presence can be available at
 * `view` when input is not.
 *
 * **Coordinates are normalised to the viewport, exactly as `InputEvent_`'s are**, rather than
 * to the document. One coordinate space for both, deliberately: the console renders the mirror
 * at the customer's own viewport size and scales the result, so the two ends already agree
 * about what `0.5, 0.5` means, and a second convention would be a second thing to keep in step.
 * Scroll is carried by the mirror's own `scroll` op, so a cursor and the page under it move
 * together without presence needing to know the offset.
 *
 * `x` and `y` are `null` when the participant's pointer is not on the shared surface at all —
 * they moved to another window, or out of the mirror, or into a region we do not report
 * (D-26). Null rather than a clamped edge coordinate, which is
 * the convention every multiplayer implementation settled on: a cursor parked against the edge
 * of the viewport is a cursor that appears to be pointing at whatever is there.
 */
export interface PresenceCursor {
  /** Normalised to [0, 1] against the viewport, or null when the pointer is not reportable. */
  x: number | null;
  y: number | null;
}

// -- what the engine sends --------------------------------------------------

export type InboundFrame =
  | {
      type: "hello.ok";
      role: Role;
      session: string;
      state: SessionState;
      mode: "cobrowse" | "screen";
      can_control: boolean;
      protocol: number;
      minimum_supported: number;
      current: Capability | null;
    }
  | { type: "request.queued"; request_id: string; workspace_id: string; legal_name: string; expires_in: number }
  | { type: "invite"; session: string; invite: string; request_id: string }
  | { type: "bound" }
  | {
      type: "consent.offer";
      descriptor: ConsentDescriptor;
      /**
       * How the panel should look, from the workspace row.
       *
       * **Beside the descriptor and not inside it**, deliberately. The descriptor is what
       * the customer signs, and presentation is not a term: putting the theme in it would
       * mean a merchant changing their brand colour invalidated every stored signature's
       * comparability, and would add a field to a canonical encoding that exists in two
       * languages. What the customer agreed to is the words; how the words were painted is
       * not part of the agreement.
       *
       * It comes from the **control plane** rather than from the page, for the same reason
       * `legal_name` and `logo_uri` do: the embedding page is the party a compromise comes
       * from, and it may not choose how the consent panel presents itself. The frame
       * validates it again on arrival regardless.
       */
      theme?: ConsentTheme | null;
    }
  | {
      type: "consented";
      session: string;
      current: Capability;
      engine_attestation: string;
      engine_public_key: string;
    }
  | { type: "session.live"; current: Capability }
  | { type: "capability.changed"; current: Capability }
  | { type: "revoked" }
  | { type: "session.ended"; reason: EndReason }
  | { type: "presence"; agents: number; subjects: number }
  /**
   * Where the *other* participant is pointing, with who they are.
   *
   * **The identity is stamped by the engine, never carried up from the sender.** A peer says
   * where it is pointing; it does not say who it is. That is the same rule `legal_name` follows
   * and for the same reason — a label a caller can author is a label an attacker can author,
   * and this one is drawn on a customer's own page. `who` is resolved from the token's `actor`
   * against the control-plane-pushed agent name (D-25), so a name that was never pushed yields
   * `null` and the cursor renders unlabelled rather than rendering a token.
   *
   * `who` is null in the agent→customer direction too, but for a different reason: the customer
   * is the customer. The console labels their cursor from its own strings rather than from
   * anything the customer's browser said about itself.
   */
  | {
      type: "presence.cursor";
      /** Which side this came from, so a peer never renders its own cursor back. */
      role: Role;
      cursor: PresenceCursor;
      /** The merchant's verified legal name, engine-supplied. Null on the customer's side. */
      merchant: string | null;
      /** The agent's display name, engine-supplied from the control plane. Null when unknown. */
      who: string | null;
    }
  | { type: "mirror"; op: string; data: unknown }
  | { type: "input"; event: InputEvent_ }
  | { type: "input.refused"; refusal: string }
  | { type: "error"; error: string };

/**
 * The named keys the engine accepts.
 *
 * Closed on purpose: an allowlist whose unknown case is "let it through" is not an
 * allowlist. Every peer applies it, so the console does not send what the engine would
 * reject as malformed — a rejection is an `error` frame and reads to the agent as an
 * outage, where a refusal reads as a rule.
 */
export const NAMED_KEYS: readonly string[] = [
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown"
];

export function isSendableKey(code: string): boolean {
  return code.length === 1 || NAMED_KEYS.includes(code);
}

// -- the SDK <-> consent frame channel --------------------------------------

/**
 * `postMessage` between the merchant's page and the consent surface.
 *
 * The frame tells the SDK its **state**, never its height. Phase 2 had it the other way
 * round: the frame measured its own content and asked to be resized, so until that message
 * arrived — or if it never did — the iframe kept the 150px a replaced element defaults to
 * and the customer saw a cropped card with the Allow button below the fold. Geometry is
 * now the SDK's, from a fixed table of two layouts, and neither is derived from content.
 */
export type FrameToPage =
  | { type: "sky.ready" }
  | { type: "sky.state"; state: ConsentSurfaceState }
  | { type: "sky.consented"; current: Capability }
  | { type: "sky.capability"; current: Capability }
  | { type: "sky.ended"; reason: EndReason };

export type PageToFrame =
  | { type: "sky.init"; session: string; invite: string; signal: string; version: string; locale: string | null }
  | { type: "sky.geometry"; ok: boolean; reason: string | null }
  | { type: "sky.stop" };

/**
 * The shapes the consent surface can have, and nothing between them.
 *
 * `ask` is a modal over the whole viewport: the customer is being asked a question and
 * nothing else on the page matters until they answer. `indicator` is the persistent
 * "someone is watching" badge with the stop control in it — small, pinned, and never
 * covering the page it is beside. `indicator-alert` is the same badge with room for one
 * line of warning. `gone` is the frame on its way out.
 *
 * A **closed set**, deliberately. The frame names a state and the SDK owns the numbers,
 * so a compromised consent surface cannot ask to be any size it likes and cover the page
 * it is supposed to sit beside.
 */
export type ConsentSurfaceState = "ask" | "indicator" | "indicator-alert" | "gone";
