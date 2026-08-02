/**
 * The harness's estate, in one process.
 *
 * Three origins, because the security properties under test are origin properties: the
 * consent surface is only unreachable from the merchant's page if it is genuinely
 * cross-origin, and `localhost:4181` is a different origin from `localhost:4180` in every
 * browser that matters. A single-origin harness would pass tests the product would fail.
 *
 *  - 4180  the merchant's site: the S-8 corpus, the integration fixtures, the built SDK
 *  - 4181  the consent surface, exactly as it is deployed
 *  - 4182  a mock engine speaking `PROTOCOL.md`
 *
 * The mock engine is deliberately small and deliberately not the real one. Its job is to
 * let a browser drive the whole subject-side flow — bind, offer, consent, narrow, revoke —
 * so the three browser artefacts are exercised. The real engine is covered by the Rust
 * suite and by `scripts/smoke.mjs` against production.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGES = resolve(HERE, "..");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

/** `/sdk/...` and `/mirror/...` reach the built artefacts; everything else is the corpus
 *  and the fixtures. Serving the *built* bundle rather than the source is the point: the
 *  thing under test is what a merchant would load. */
function resolveMerchant(pathname) {
  if (pathname.startsWith("/sdk/")) return join(PACKAGES, "sdk/dist", pathname.slice(5));
  if (pathname.startsWith("/mirror/")) return join(PACKAGES, "mirror/dist", pathname.slice(8));
  if (pathname.startsWith("/harness/")) return join(HERE, pathname.slice(9));
  return join(HERE, "corpus", pathname === "/" ? "index.html" : pathname);
}

function staticServer(resolvePath) {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/theme" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          theme = body ? JSON.parse(body) : null;
        } catch {
          theme = null;
        }
        res.writeHead(204, { "access-control-allow-origin": "*" }).end();
      });
      return;
    }
    const target = resolvePath(normalize(url.pathname));
    // No path escapes the roots this server is allowed to read.
    if (!target.startsWith(PACKAGES)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    createReadStream(target).pipe(res);
  });
}

const merchant = staticServer(resolveMerchant);
const consent = staticServer((p) => join(PACKAGES, "consent/dist", p === "/" ? "index.html" : p), PACKAGES);

// ---------------------------------------------------------------------------
// The mock engine
// ---------------------------------------------------------------------------

const CEILING = {
  access: "control",
  surfaces: [{ kind: "document" }],
  clipboard: "none",
  file_transfer: "none",
  tier: "t0",
  expires_at_unix: 2000000000,
  max_duration_ms: 1_800_000
};

const sessions = new Map();

/**
 * The theme the mock engine attaches to an offer.
 *
 * Set by a test through `POST /theme` on the merchant origin, because the real one comes
 * from the workspace row through the control plane and never from the page — a harness that
 * let the page set it would be testing a path the product does not have.
 */
let theme = null;

function sessionOf(id) {
  let s = sessions.get(id);
  if (!s) {
    // `roles` is owned here, beside `peers`, so nothing downstream has to guard for its absence.
    s = {
      id,
      state: "minted",
      current: null,
      peers: new Set(),
      roles: new Map(),
      descriptor: null
    };
    sessions.set(id, s);
  }
  return s;
}

function broadcast(session, frame, except) {
  for (const peer of session.peers) {
    if (peer === except) continue;
    if (peer.readyState === 1) peer.send(JSON.stringify(frame));
  }
}

/** What the engine broadcasts to `Audience::Everyone` whenever a peer attaches or leaves. */
function announcePresence(session) {
  const roles = session.roles;
  let agents = 0;
  let subjects = 0;
  for (const r of roles.values()) {
    if (r === "agent") agents++;
    if (r === "subject") subjects++;
  }
  broadcast(session, { type: "presence", agents, subjects });
}

const signal = new WebSocketServer({ port: 4182 });
signal.on("connection", (socket, request) => {
  let session = null;
  let role = null;
  const origin = request.headers.origin ?? null;

  socket.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    const reply = (f) => socket.send(JSON.stringify(f));

    if (frame.type === "hello") {
      role = frame.role;
      if (role === "visitor") {
        reply({
          type: "request.queued",
          request_id: "req_harness",
          workspace_id: "ws_harness",
          legal_name: "Cyclo SAS",
          expires_in: 900
        });
        return;
      }
      session = sessionOf(frame.session);
      session.peers.add(socket);
      // Counted by role, because the SDK re-snapshots when the agent count goes UP — an
      // agent that attaches after the first snapshot would otherwise render a blank page
      // forever. A mock that hardcoded `agents: 1` could not exercise that at all.
      session.roles.set(socket, role);
      reply({
        type: "hello.ok",
        role,
        session: session.id,
        state: session.state,
        mode: "cobrowse",
        can_control: true,
        protocol: 1,
        minimum_supported: 1,
        current: session.current
      });
      announcePresence(session);
      return;
    }
    if (!session) return;

    switch (frame.type) {
      case "bind":
        session.state = "bound";
        reply({ type: "bound" });
        return;
      case "consent.request": {
        // The consent plane is gated on the socket's browser-set `Origin`, exactly as the
        // engine gates it. A harness that skipped this would pass a build in which the
        // subject plane was not real, which is the review finding that produced the check.
        if (!origin || !origin.includes("4181")) {
          reply({ type: "error", error: "consent may only come from the consent origin" });
          return;
        }
        session.descriptor = {
          session: session.id,
          workspace: "ws_harness",
          mode: "cobrowse",
          display_identity: {
            legal_name: "Cyclo SAS",
            logo_uri: null,
            verified_at: null,
            verification_authority: null
          },
          agent: "act_harness",
          origin: frame.origin,
          ceiling: CEILING,
          session_public_key: frame.session_public_key,
          scope_text:
            "Cyclo SAS can see and use this page for up to 30 minutes. You can stop at any time.",
          issued_at: 1800000000
        };
        reply({ type: "consent.offer", descriptor: session.descriptor, theme });
        return;
      }
      case "consent":
        if (!frame.subject_signature) {
          reply({ type: "error", error: "no signature" });
          return;
        }
        session.state = "live";
        session.current = { ...CEILING };
        reply({
          type: "consented",
          session: session.id,
          current: session.current,
          engine_attestation: "",
          engine_public_key: ""
        });
        broadcast(session, { type: "session.live", current: session.current });
        announcePresence(session);
        return;
      case "capability.set":
        session.current = frame.current;
        broadcast(session, { type: "capability.changed", current: session.current });
        return;
      case "revoke":
        session.state = "ended";
        broadcast(session, { type: "session.ended", reason: "revoked_by_customer" });
        return;
      case "mirror":
        broadcast(session, { type: "mirror", op: frame.op, data: frame.data }, socket);
        return;
      case "input":
        broadcast(session, { type: "input", event: frame.event }, socket);
        return;
      case "presence.cursor": {
        // The real engine's rules, in miniature, because the browser tests are the only place
        // both ends run at once:
        //
        //  - **re-authored, not relayed.** The sender says where it is pointing and never who
        //    it is; `role`, `merchant` and `who` are the engine's to stamp (D-25).
        //  - **gated on streaming**, the same predicate `mirror` is gated on (D-27). A cursor
        //    on a paused page is a lie about the session's state.
        const role = session.roles.get(socket);
        const streaming = session.state === "live" && (session.current?.surfaces?.length ?? 0) > 0;
        if (!streaming) return;
        broadcast(
          session,
          {
            type: "presence.cursor",
            role,
            cursor: frame.cursor,
            merchant: role === "agent" ? "Cyclo SAS" : null,
            who: role === "agent" ? "Amélie" : null
          },
          socket
        );
        return;
      }
      default:
        return;
    }
  });

  socket.on("close", () => {
    if (!session) return;
    session.peers.delete(socket);
    session.roles.delete(socket);
    // So a reconnecting agent produces a real 1 -> 0 -> 1 transition, which is the sequence
    // the SDK's re-snapshot keys on.
    announcePresence(session);
  });
});

merchant.listen(4180);
consent.listen(4181);
console.log("harness: merchant :4180  consent :4181  signal :4182");
