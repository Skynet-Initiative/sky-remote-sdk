# sky-remote — public source

Everything in sky-remote that runs on a machine we do not control: the in-page SDK, the consent
surface, the wire contract they speak, and the test suites that hold their privacy claims up.

The npm package [`@skynet-initiative/sky-remote`](https://www.npmjs.com/package/@skynet-initiative/sky-remote)
is built from [`sdk/`](sdk) in this repository. **Start at [`sdk/README.md`](sdk/README.md)** if
you are integrating; [`sdk/API.md`](sdk/API.md) is the full reference.

## Why this is public

Not for the usual reason. This is a support tool that runs in a merchant's page with full DOM
access — it can read the page, and with the customer's consent it can act in it. The safety case
for shipping something like that rests on it being readable by people who have no reason to
trust us, and for as long as this source was private, that case was not one we could actually
make.

So the trade is deliberate: **the source is public and unobfuscated, and the licence — not
obscurity — is what stops it becoming someone else's product.** Obfuscating a bundle that is
already delivered to every visitor's browser would have protected nothing and cost the only
property the security argument depends on.

[`VERIFYING.md`](VERIFYING.md) is the practical end of that: how to check that the bytes running
in your customers' pages are the ones in this repository, in three commands, without asking us
for anything.

## What is here, and what is not

| | |
| --- | --- |
| [`sdk/`](sdk) | The in-page SDK. Published to npm. Serializer, privacy classifier, input chokepoint, consent host, presence, mirror stream. |
| [`consent/`](consent) | The consent surface, served cross-origin from `consent.skynet-initiative.com`. It signs on the customer's device and recomputes the digest itself rather than signing what the engine hands it — public so that claim is checkable. |
| [`protocol/`](protocol) | The wire contract. Bundled into the SDK; see [`PROTOCOL.md`](PROTOCOL.md). |
| [`mirror/`](mirror) | The agent-side rebuilder. Runs in our console, not in your page. Not published; here because it renders untrusted markup and that is worth reading too. |
| [`harness/`](harness) | Playwright suite and the fidelity/privacy corpus. |
| [`tests/`](tests) | Node tests, including the cross-language consent-digest pin. |

**Not here, and deliberately:** the relay engine, the control plane, the audit and tombstoning
machinery, the database schema, and the deployment configuration. Those live in a private
repository. The SDK is inert without them, which is exactly why the split falls where it does —
the half that has to run on someone else's machine is the half that has to be readable.

## Licence

**[Business Source License 1.1](LICENSE).** In plain terms, and the file is what counts:

- **You may run this in production, free, on sites and apps you operate** — any number of users,
  sessions or page views. You may install it from npm, bundle it, self-host the output and modify
  it.
- **You may not build a co-browse, screen-sharing or remote-assistance product out of it** and
  offer that to other people.
- **You may read it, run it, test it and publish a security review of it.** That needs no
  permission and the licence says so explicitly.
- **On 2030-08-02 it becomes Apache-2.0**, automatically, for every version released under these
  terms.

This replaced Apache-2.0 before the first public release. Apache-2.0 granted, in as many words,
the one thing worth withholding — the right to take this and ship a competing product — while
protecting nothing that mattered, since the bundle is delivered to every visitor's browser
regardless. The licence is the tool for that job; obfuscation is not.

The terms are enforced by the build rather than left to a README: `build.mjs` fails if the
manifest, the `LICENSE` file and the banner in the shipped bytes do not agree, so a bundle found
with no repository attached still carries its terms.

## Working on it

```sh
npm ci
npm run check          # typecheck · node tests · build with the shipped-byte invariants
npm run test:browser   # Playwright (needs: npx playwright install chromium)
npm run dev            # watch
```

`npm run check` enforces three things that are product claims rather than build hygiene, each
checked against what is emitted rather than what the source intended:

1. **Zero runtime dependencies** in any published package. Not few — zero. A transitive
   dependency inside a bundle with full DOM access on thousands of sites is the Polyfill
   incident waiting to happen again.
2. **No browser storage anywhere in the built bytes** — no `localStorage`, `sessionStorage`,
   `indexedDB` or `document.cookie`. This is what lets a merchant add the script tag without
   declaring us in their consent-management platform.
3. **The licence agrees with itself** across the manifest, the file and the bundle banner.

### The consent digest is pinned across two repositories

The canonical consent encoding exists twice — once in Rust in the private engine, once in
[`protocol/src/canonical.ts`](protocol/src/canonical.ts) — because the consent surface must
recompute the digest rather than sign bytes the engine hands it. Two hand-written
implementations of one format is the pairing that drifts silently while both sides' tests stay
green.

[`tests/consent-fixture.json`](tests/consent-fixture.json) is the pin. It holds real descriptors
and the digests the Rust implementation produces for them; `tests/canonical.test.ts` recomputes
them here, and the engine's CI regenerates the file and fails if it differs from this copy.
Neither side can move alone.

**If you change `canonical.ts`, expect the engine repository to go red** — that is the mechanism
working, not a broken build to route around.
