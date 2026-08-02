/**
 * The consent descriptor's canonical byte encoding, in TypeScript.
 *
 * This is the second implementation of `crates/core/src/enc.rs` plus
 * `ConsentDescriptor::encode`, and it exists for one reason: **the consent surface must
 * not sign a digest the engine hands it.**
 *
 * `docs/03-trust-model.md`'s acceptance test for the whole architecture is "assume the
 * platform is compromised and show the customer's machine is still safe." A frame that
 * signs whatever bytes it is given fails that test outright — a hostile engine would
 * display "can see this page" and collect a signature over "can see and control this
 * page". Recomputing the digest from the fields that are actually rendered is what closes
 * that gap, and it is why this file duplicates Rust rather than calling it.
 *
 * Two hand-written implementations of one format in two languages is the pairing that
 * drifts silently: both sides' tests stay green while nothing crosses between them. So it
 * is pinned. `crates/engine/tests/consent_fixture.rs` writes real descriptors and their
 * real digests, and `packages/tests/canonical.test.ts` recomputes them here.
 *
 * The encoding itself is deliberately dull: every variable-length field is preceded by
 * its length as a big-endian u64, so no two distinct field sequences produce the same
 * bytes.
 */

const DOMAIN = "sky-remote/consent-descriptor/v1";

export type Access = "view" | "control";
export type Clipboard = "none" | "to_agent" | "bidirectional";
export type FileTransfer = "none" | "single_file_explicit";
export type Tier = "t0" | "t1" | "t2";
export type Mode = "cobrowse" | "screen";

export type Surface =
  | { kind: "document" }
  | { kind: "display"; index: number }
  | { kind: "window"; id: number | string }
  | { kind: "app"; name: string };

export interface Capability {
  access: Access;
  surfaces: Surface[];
  clipboard: Clipboard;
  file_transfer: FileTransfer;
  tier: Tier;
  expires_at_unix: number;
  max_duration_ms: number;
}

export interface DisplayIdentity {
  legal_name: string;
  logo_uri: string | null;
  verified_at: number | null;
  verification_authority: string | null;
}

export interface ConsentDescriptor {
  session: string;
  workspace: string;
  mode: Mode;
  display_identity: DisplayIdentity;
  agent: string;
  origin: string | null;
  ceiling: Capability;
  session_public_key: string;
  scope_text: string;
  issued_at: number;
}

/** Append-only byte writer. Mirrors `enc::Writer` field for field. */
export class Writer {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    this.length += bytes.length;
    return this;
  }

  u8(v: number): this {
    return this.raw(Uint8Array.of(v & 0xff));
  }

  u16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, false);
    return this.raw(b);
  }

  /** Big-endian 64-bit. BigInt, because a session id's timestamp exceeds 2^53 in
   *  milliseconds and `Number` would round it — silently, and only for some values. */
  u64(v: number | bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), false);
    return this.raw(b);
  }

  /** Two's complement, so a negative timestamp encodes the way `i64::to_be_bytes` does. */
  i64(v: number | bigint): this {
    return this.u64(BigInt.asUintN(64, BigInt(v)));
  }

  /** Length-prefixed UTF-8. The length counts BYTES, not code units: `"é".length` is 1 in
   *  JavaScript and 2 in UTF-8, and a frame that prefixed the wrong one would agree with
   *  Rust on ASCII and disagree the moment a merchant has an accent in their name. */
  str(s: string | null | undefined): this {
    const bytes = new TextEncoder().encode(s == null ? "" : String(s));
    this.u64(bytes.length);
    return this.raw(bytes);
  }

  /** `None` and `Some("")` must not collide, so the discriminant goes first. */
  optStr(s: string | null | undefined): this {
    if (s === null || s === undefined) return this.u8(0);
    this.u8(1);
    return this.str(s);
  }

  seqLen(n: number): this {
    return this.u64(n);
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

const ACCESS: Record<string, number> = { view: 0, control: 1 };
const CLIPBOARD: Record<string, number> = { none: 0, to_agent: 1, bidirectional: 2 };
const FILE_TRANSFER: Record<string, number> = { none: 0, single_file_explicit: 1 };
const TIER: Record<string, number> = { t0: 0, t1: 1, t2: 2 };
const MODE: Record<string, number> = { cobrowse: 0, screen: 1 };

/** An enum tag, or a throw. There is no default: a capability that encoded as something
 *  other than what it says would produce a signature over terms nobody agreed to. */
function tag(table: Record<string, number>, value: string, field: string): number {
  const n = table[value];
  if (n === undefined) {
    throw new Error(`consent descriptor: unknown ${field} ${JSON.stringify(value)}`);
  }
  return n;
}

export function encodeCapability(w: Writer, c: Capability): Writer {
  w.u8(tag(ACCESS, c.access, "access"));
  const surfaces = c.surfaces || [];
  w.seqLen(surfaces.length);
  for (const s of surfaces) {
    switch (s.kind) {
      case "document":
        w.u8(0);
        break;
      case "display":
        w.u8(1).u16(s.index);
        break;
      case "window":
        // The engine's `Surface::Window { id: u64 }` exceeds 2^53 on Windows handles, so
        // the wire carries it as a string when it has to. `BigInt` takes either.
        w.u8(2).u64(BigInt(s.id));
        break;
      case "app":
        w.u8(3).str(s.name);
        break;
      default:
        throw new Error(
          `consent descriptor: unknown surface ${JSON.stringify((s as { kind: string }).kind)}`
        );
    }
  }
  w.u8(tag(CLIPBOARD, c.clipboard, "clipboard"));
  w.u8(tag(FILE_TRANSFER, c.file_transfer, "file_transfer"));
  w.u8(tag(TIER, c.tier, "tier"));
  w.i64(c.expires_at_unix);
  w.u64(c.max_duration_ms);
  return w;
}

/** Base64 (standard alphabet, padded) to bytes. */
export function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/**
 * The exact bytes `ConsentDescriptor::digest` hashes.
 *
 * Field order is the contract and it is the same order as `impl Canonical for
 * ConsentDescriptor`. Adding a field to one side and not the other makes every signature
 * stop verifying, which is the loud failure — the quiet one would be a field that is
 * *displayed* and not encoded, and that is why `scope_text` is in here.
 */
export function canonicalBytes(d: ConsentDescriptor): Uint8Array {
  const w = new Writer();
  w.str(DOMAIN);
  w.str(d.session);
  w.str(d.workspace);
  w.u8(tag(MODE, d.mode, "mode"));

  const identity = d.display_identity || ({} as DisplayIdentity);
  w.str(identity.legal_name);
  w.optStr(identity.logo_uri);
  if (identity.verified_at === null || identity.verified_at === undefined) {
    w.u8(0);
  } else {
    w.u8(1).i64(identity.verified_at);
  }
  w.optStr(identity.verification_authority);

  w.str(d.agent);
  w.optStr(d.origin);
  encodeCapability(w, d.ceiling);

  const key = fromBase64(d.session_public_key);
  if (key.length !== 32) throw new Error("consent descriptor: session key is not 32 bytes");
  w.raw(key);

  w.str(d.scope_text);
  w.i64(d.issued_at);
  return w.finish();
}

/** SHA-256 of the canonical bytes — what the subject signature covers. */
export async function canonicalDigest(
  descriptor: ConsentDescriptor,
  subtle?: SubtleCrypto
): Promise<Uint8Array> {
  const bytes = canonicalBytes(descriptor);
  const hash = await (subtle || crypto.subtle).digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(hash);
}
