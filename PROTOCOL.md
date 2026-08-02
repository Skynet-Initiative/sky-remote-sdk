# The signalling protocol

One WebSocket, `wss://remote.skynet-initiative.com/signal`, three kinds of peer. This is the
contract between four implementations — the engine (`crates/engine/src/signal.rs`), the SDK
(`sdk/dist/sky.js`), the consent surface (`consent/dist/consent.js`) and the agent console
(ecosystem, `components/sky-remote/console-view.tsx`).

**JSON, not protobuf**, and the reason is the bundle. `crates/proto` exists and the audit
vocabulary is pinned by `crates/core/tests/wire_codes.rs` regardless of encoding, but three of
the four peers are browsers and the SDK has **zero runtime dependencies** by rule
(the integration contract, embed rule 2). A protobuf runtime is either a dependency
in a bundle with full DOM access on merchants' pages — the Polyfill risk reintroduced — or a
hand-written encoder, which is a second wire format to keep in step for no gain over
`permessage-deflate` on string-heavy DOM data. Protobuf earns its place on the media path in
phase 3, where the payload is binary and both peers are Rust.

---

## The handshake

The upgrade is **anonymous**. Only the `Origin` header is checked, against
`SKY_REMOTE_SIGNAL_ALLOWED_ORIGINS`, which is empty by default and empty allows nothing.

The first frame must be `hello` and carries the credential. Nothing else is read before it, and
the socket closes after ten seconds without one.

> Phase 1 carried the token as `?token=…`. A query string reaches access logs, `Referer`
> headers and browser history in a way a frame does not; with three credential types the query
> shape would have had to grow anyway. This removes the logging exposure. It is not DPoP and
> does not pretend to be — a stolen token is still a usable token.

| Role | Credential | May |
| --- | --- | --- |
| `visitor` | `pk_live_…` — **grants nothing** | Queue one assistance request and wait |
| `subject` | the invite for one session | Bind, consent, narrow, revoke, carry the mirror |
| `agent` | a platform token scoped to that session | Watch, and with `control`, send input |

```json
{"type":"hello","role":"visitor","key":"pk_live_…","page":"/checkout","note":"…"}
{"type":"hello","role":"subject","session":"sess_…","invite":"inv_…"}
{"type":"hello","role":"agent","session":"sess_…","token":"<platform token>"}
```

The reply is `hello.ok`, or `error` and a close.

```json
{"type":"hello.ok","role":"subject","session":"sess_…","state":"minted","mode":"cobrowse",
 "can_control":false,"protocol":1,"minimum_supported":1,"current":null}
```

A wrong session id and a wrong invite produce the **same** answer, so neither is an oracle for
the other.

---

## Visitor: raising a hand

`hello` → `request.queued` → (an agent answers) → `invite` → the socket closes.

```json
{"type":"request.queued","request_id":"req_…","workspace_id":"ws_…",
 "legal_name":"Cyclo SAS","expires_in":900}
{"type":"invite","session":"sess_…","invite":"inv_…","request_id":"req_…"}
```

The page then reconnects as `subject` with that invite — a second handshake rather than
promoting the socket in place, so the invited path and the integrator-delivered path are the
same code on both ends.

**No session exists until an agent answers.** A request is a row in a console queue and nothing
else.

---

## Subject: bind, consent, stream, stop

### `bind` → `bound`

```json
{"type":"bind","version":1,"minimum_supported":1}
```

The protocol floor is compared here and nowhere else — the security-hotfix lever from
D-16.

### `consent.request` → `consent.offer`

```json
{"type":"consent.request","session_public_key":"<32 bytes, base64>","origin":"https://cyclo.fr"}
```

**The client supplies its public key and nothing else.** The merchant's name, the agent
reference, the ceiling and the words all come from the workspace row and the session. Nobody —
including a platform operator — can author consent text (refuse-list item 8).

The engine replies with the exact descriptor and **retains it** until a signature answers.
Rebuilding it at consent time would re-read the clock, and a descriptor whose `issued_at` moved
is a different descriptor with a different digest.

```json
{"type":"consent.offer","descriptor":{
  "session":"sess_…","workspace":"ws_…","mode":"cobrowse",
  "display_identity":{"legal_name":"Cyclo SAS","logo_uri":null,
                      "verified_at":null,"verification_authority":null},
  "agent":"act_…","origin":"https://cyclo.fr",
  "ceiling":{"access":"view","surfaces":[{"kind":"document"}],"clipboard":"none",
             "file_transfer":"none","tier":"t0",
             "expires_at_unix":1800001800,"max_duration_ms":1800000},
  "session_public_key":"<base64>","scope_text":"…","issued_at":1800000000}}
```

Every field the canonical encoder writes is present, not a rendered summary — because the
surface recomputes the digest and signs *that*.

### `consent` → `consented`

```json
{"type":"consent","subject_signature":"<64 bytes, base64>"}
```

Ed25519 over `SHA-256(canonical bytes of the descriptor)`, by the key whose public half is
inside that descriptor. The canonical encoding is `crates/core/src/enc.rs` in Rust and
`protocol/src/canonical.ts` in JavaScript, pinned to each other by
`crates/engine/tests/consent_fixture.rs` and `packages/tests/canonical.test.ts`.

`ConsentRecord::accept` verifies it. A signature that does not verify against **this** offer is
refused, and "absent" and "does not verify" are the same refusal.

The offer is `take`n, so one signature cannot consent twice.

```json
{"type":"consented","session":"sess_…","current":{…},
 "engine_attestation":"<base64>","engine_public_key":"<base64>"}
```

`session.live` then goes to every peer.

### `capability.set` → `capability.changed`

Narrowing is the customer's, instant and unconditional; the server observes rather than
authorises. Widening is bounded by the ceiling pinned at consent.

```json
{"type":"capability.set","current":{ …the full vector, one field changed… }}
```

**Echo the vector you were given.** A freshly computed `expires_at_unix` lands after the
ceiling pinned at consent and the engine refuses it: a session cannot extend its own deadline.

`surfaces: []` means "show them nothing" without ending the session. The engine then carries no
mirror frames at all.

### `revoke` → `revoked`

Local, immediate, consults nothing. Every peer gets `session.ended`.

### `mirror`

Relayed **verbatim** to agents, as an opaque string. The engine has no DOM model and must not
acquire one.

**`MAX_FRAME_BYTES` is 4 MiB and this paragraph is where the three peers agree on it.** A frame
over the limit closes the connection rather than being truncated — half a snapshot is worse than
none, because the console would render it as though complete. It is enforced twice at the
engine: at the transport (`max_message_size` on the upgrade), so an anonymous peer cannot make a
node buffer more than the ceiling before any credential is read, and again on the decoded frame,
which is what produces a readable `error` frame. Because the transport refuses the read, a peer
over the limit may see the socket close with **no error frame at all**.

The SDK therefore measures its own snapshot against this number before sending and reports
`degraded` when it will not fit — it cannot make the page smaller, but the alternative is a
session that ends by itself on page load with nothing said to anybody. The serializer's
per-part caps (32 KB per inline image, 512 KB per stylesheet) bound the pieces; only this bounds
the whole.

```json
{"type":"mirror","op":"snapshot","data":{"root":{…},"viewport":{"w":1280,"h":800},
                                          "scroll":{"x":0,"y":0},"href":"…"}}
{"type":"mirror","op":"mutate","data":{"adds":[…],"removes":[…],"attrs":[…],"texts":[…]}}
{"type":"mirror","op":"scroll","data":{"id":1,"x":0,"y":420}}
{"type":"mirror","op":"viewport","data":{"w":1280,"h":800}}
{"type":"mirror","op":"refused","data":{"refusal":"cross-origin-frame"}}
```

#### The node model

```
{ id, t: "doc" | "dt" | "el" | "tx",
  n:  tag name (el) or doctype name,
  ns: "svg" when in the SVG namespace,
  a:  { attribute: value },        // masked where it carries content; no `on*` handlers
  c:  [ children ],
  v:  text (tx),
  o:  opaque reason — see below }
```

`id` is a stable integer per node for the life of the session. A node carrying `o` has **no
children**: the serializer could not represent it, so nothing beneath it was walked.

#### `o`, the unrepresentable-region marker

This is the one representation both ends must agree on, and it is the rule most likely to be
quietly not-implemented.

| Value | What it is |
| --- | --- |
| `cross-origin-frame` | An `<iframe>`, `<frame>`, `<object>` or `<embed>` |
| `closed-shadow-root` | A custom element with no reachable shadow root |
| `canvas` | `<canvas>`, `<video>`, `<audio>` |
| `masked` | A field whose contents the agent cannot read |
| `consent-surface` | The customer's own consent panel |

**Marked by the serializer, rendered inert by the console, enforced by the SDK.** The console
draws the region striped with the reason on it, so the agent knows why rather than assuming a
bug. The SDK refuses input into it at dispatch time, resolved against the **live** DOM with
`elementFromPoint` rather than against a stale snapshot — so a region that became opaque since
the last frame is still refused.

The console keeps its own copy and warns before sending, but that copy is advisory. If the two
disagree the SDK's wins, because a console that could talk itself into a click would not be a
chokepoint.

### `input` (agent → engine → subject)

```json
{"type":"input","event":{"kind":"pointer","x":0.5,"y":0.5,"button":"primary","action":"down"}}
{"type":"input","event":{"kind":"scroll","x":0.5,"y":0.5,"dx":0,"dy":-120}}
{"type":"input","event":{"kind":"key","code":"Enter","action":"down"}}
```

Coordinates are normalised to `[0, 1]`, so the agent never learns the endpoint's resolution and
a resize cannot turn a stale click into a click somewhere else. Out of range is refused, never
clamped. `code` is one character, or a name from the closed list — an unknown name is refused
rather than taken as text, because an allowlist whose unknown case is "let it through" is not
an allowlist.

Refused input comes back to the agent only:

```json
{"type":"input.refused","refusal":"not-permitted-by-capability"}
```

`not-permitted-by-capability` · `no-surfaces-permitted` · `not-live` · `expired` ·
`not-on-allowlist` · `requires-tier` · `region-not-representable` · `sink-failed` ·
`wrong-session`

The engine writes an audit event on the **first** refusal of each kind, not on every one:
dispatch runs per pointer move, and thousands of identical rows in an append-only chain would
bury the distinct attempt classes an auditor is looking for.

### `presence`

```json
{"type":"presence","agents":1,"subjects":2}
```

Two subjects is normal: the SDK carries the mirror and the consent frame carries consent and
the stop control. The customer's indicator is driven by `agents` — refuse-list item 2 makes it
non-negotiable that they can see when someone is watching.

### `presence.cursor` (either side → engine → the other side)

Sent:

```json
{"type":"presence.cursor","cursor":{"x":0.42,"y":0.61}}
{"type":"presence.cursor","cursor":{"x":null,"y":null}}
```

Received:

```json
{"type":"presence.cursor","role":"agent","cursor":{"x":0.42,"y":0.61},
 "merchant":"Cyclo SAS","who":"Amélie"}
```

**This is not an input event, and the shape is the argument** (D-23).
There is no button, no action and no key — a position and an identity, and nothing that could be
performed. It is therefore available at `view`: a view-only agent can point at the blue button
instead of describing it, which is the thing every comparable product allows and this one could
not.

Coordinates are normalised to the **viewport**, exactly as `input`'s are, so the two ends need
only one convention. `null` means the pointer is not on the shared surface — another window, off
the mirror, or inside a region we do not report. Null rather than a clamped edge coordinate,
because a cursor parked against the edge appears to point at whatever is there.

**The sender does not say who it is.** `role`, `merchant` and `who` are stamped by the engine.
`who` is resolved from the token's `actor` against the name pushed over the admin plane
(D-25); a name that was never pushed yields `null` and the cursor
renders unlabelled rather than rendering an `act_…` token at a customer. A label a caller can
author is a label an attacker can author, and this one is drawn on a customer's own page.

Rate is `PRESENCE_THROTTLE_MS` — 50 ms, 20 Hz — throttled by both ends and not policed by the
engine. Receivers interpolate with a linear CSS transition of the same duration, and hide a
cursor that has been silent for `PRESENCE_IDLE_MS` (2 s), which is the backstop for a socket
that went quiet without saying so.

**Presence stops when streaming stops, in both directions**
(D-27). The engine refuses to relay a presence frame unless
`session.is_live()` and `current.surfaces` is non-empty — the identical predicate that gates
`mirror`. A cursor still moving on a page the customer has paused is a lie about the session's
state, drawn by us.

**The customer's cursor is suppressed inside masked regions**
(D-26), at the SDK, using the same opaque-marker walk the input
chokepoint uses. The agent's cursor over a masked region is *shown*, in the inert style: a
cursor is not a click, the region stays untypeable, and pointing at the box the customer must
fill in is the common support case.

---

## Frames by role

| Frame | `visitor` | `subject` | `agent` |
| --- | --- | --- | --- |
| `bind`, `consent.request`, `consent`, `capability.set`, `revoke`, `mirror` | — | ✓ | — |
| `input` | — | — | ✓ |
| `presence.cursor` | — | ✓ | ✓ |
| `ping` | — | ✓ | ✓ |

Anything else is `{"type":"error","error":"a subject may not send `input`"}`. Role routing is
checked at the frame boundary, before any handler runs.
