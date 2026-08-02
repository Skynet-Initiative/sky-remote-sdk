# Verifying what runs in your customers' pages

This SDK runs inside your page with full access to your DOM. Three things about it are
checkable, by anyone, without asking us for anything — and this file is how.

**What that is worth, stated first.** Checking makes a dishonest release *discoverable*. It does
not make one impossible, and realistically almost nobody will run these commands. If you are
deciding whether to put this in your checkout flow, the things carrying that decision are the
contract, our attestations, and what happens to us if we abuse it — the same things that carry it
for Stripe.js, which is a megabyte of minified JavaScript with no public source at all. This page
is a floor under those, not a substitute for them.

---

## 1. That the bytes came from a commit in this repository

npm attaches a **provenance attestation** to every release: a signed statement binding the
tarball to the exact commit and the exact workflow run that produced it, recorded in a public
transparency log.

```sh
npm install @skynet-initiative/sky-remote
npm audit signatures
```

The package page on npm shows the same thing with a link to the build. This tells you the
registry is serving what our release workflow uploaded — and nothing more than that.

## 2. That the commit actually builds those bytes

Provenance says *which* commit. It does not say that commit's source and the artefact agree; a
tampered workflow would produce a valid attestation over the wrong bytes. So rebuild it:

```sh
git clone https://github.com/Skynet-Initiative/sky-remote-sdk
cd sky-remote-sdk
git checkout sdk-v0.1.2        # the tag matching the version you installed
npm ci
node verify.mjs 0.1.2
```

`verify.mjs` downloads the published tarball, rebuilds from your checkout, and compares every
shipped artefact byte for byte. It exits non-zero on any mismatch.

**The build is deterministic**, which is what makes byte-for-byte a fair bar rather than an
unreasonable one: `esbuild` is pinned by `package-lock.json`, the only injected value is the
version string, and nothing in the build reads the clock, the environment or the network. CI
rebuilds twice on every commit and fails if the two differ, so this property is maintained
rather than assumed.

## 3. That the file your browser loads is the file you checked

If you use the script tag rather than npm, pin the version and the hash:

```html
<script
  src="https://sdk.skynet-initiative.com/v/0.1.2/sky.js"
  integrity="sha384-…"
  crossorigin="anonymous"
  data-workspace="pk_live_…"
  defer></script>
```

Take both values from [`/integrity.json`](https://sdk.skynet-initiative.com/integrity.json),
which is generated from the bytes the origin actually serves, so it cannot describe a file that
is not there. The origin itself is laid out from published npm tarballs and verifies each one's
provenance at image build, so `/v/0.1.2/sky.js` and the npm tarball are the same bytes by
construction rather than by policy.

`/v/<version>/sky.js` is immutable. `sky.js` without a version moves with each release and
therefore cannot carry an integrity hash — use it while integrating, not in production.

---

## Reading it

Read the source, not the bundle. `sdk/src/` is 39% comments and that is where the reasoning is;
`esbuild` strips those, so an unminified build would give you the *what* with none of the *why*.
There used to be one, `sky.debug.js`, and it was removed for exactly that reason — step 2 above
is the honest version of what it was pretending to offer.

The parts most worth reading, in the order a security review usually wants them:

| Question | File |
| --- | --- |
| What is masked, and what decides that? | [`sdk/src/privacy.ts`](sdk/src/privacy.ts) |
| What leaves the page, and in what shape? | [`sdk/src/serializer.ts`](sdk/src/serializer.ts) |
| What can an agent do to my page? | [`sdk/src/input.ts`](sdk/src/input.ts) |
| How is consent bound to the customer's device? | [`consent/src/consent.ts`](consent/src/consent.ts) |
| What is on the wire? | [`PROTOCOL.md`](PROTOCOL.md), [`protocol/src/`](protocol/src) |

The tests that hold the privacy claims up are in [`harness/tests/`](harness/tests) and
[`tests/`](tests), and run on any machine with `npm ci && npm run check`.

## What this does not prove

Stated plainly, because a verification page that oversells itself is worse than none:

- **It says nothing about the engine.** The relay, the control plane and the audit trail are
  closed source. What this SDK sends is checkable from here; what we do with it afterwards is a
  contractual and audit question, not a cryptographic one.
- **It is a point-in-time check.** It tells you the version you checked is honest. Your lockfile or your
  SRI hash is what stops that answer being replaced without you noticing — which is why this SDK
  has no silent auto-update channel.
- **A signature is not a safety property.** Reproducible, attested code can still be code you do
  not want. Verification tells you *what* we shipped, never whether shipping it was honest.
- **Public source prevents nothing.** It makes malice discoverable by whoever looks, and the
  honest expectation is that hardly anyone does. We used to describe this as part of what keeps
  the SDK safe; that was a category error and the claim was withdrawn on 2026-08-02. What keeps
  it safe is that we do not write that code, that the bundle has no runtime dependencies that
  could, and that we are accountable if either stops being true.

Found a mismatch, or something the source does that this claims it does not?
<https://github.com/Skynet-Initiative/sky-remote-sdk/issues>. Publishing what you find is
explicitly permitted by the licence and needs no permission from us.
