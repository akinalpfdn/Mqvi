# Security Policy

mqvi handles private conversations, end-to-end encrypted messages, voice and video, and uploaded
files. Security reports are taken seriously and are welcome.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Use either:

- **[GitHub private vulnerability reporting](https://github.com/akinalpfdn/Mqvi/security/advisories/new)** — preferred
- **Email:** contact@mqvi.net

If you want to encrypt the report, say so in a first message and we will arrange a key.

### What to include

- What the issue is and roughly how severe you think it is
- Steps to reproduce, or a proof of concept
- The version, commit or release you tested against
- Whether it affects the hosted mqvi.net service, self-hosted deployments, or both

### What to expect

- **Acknowledgement within 72 hours.** If you have not heard back, please follow up — assume it got
  lost rather than ignored.
- An assessment and a rough timeline once the report is confirmed.
- Progress updates while a fix is being prepared.
- Credit in the release notes when the fix ships, unless you would rather stay anonymous.

This is a small project. There is no bug bounty programme and no monetary reward.

## Supported versions

Fixes land on `main` and go out in the next release. Only the **latest release** is supported —
mqvi auto-updates on desktop and mobile, and self-hosters can update by re-running the installer.

Self-hosted deployments are the operator's responsibility to update. Security fixes are noted in the
release notes so operators can judge urgency.

## Scope

**In scope**

- The server (`server/`), including authentication, authorization, the WebSocket layer, file
  handling and the admin surface
- The clients (`client/`, `electron/`, mobile shells) — including anything that would let a
  malicious server or peer compromise a client
- The end-to-end encryption implementation (`client/src/crypto/`) and the voice E2EE path
- The self-host installer and deployment scripts (`deploy/`)
- Cross-tenant issues: reaching another server's, channel's or user's data

**Out of scope**

- Vulnerabilities in third-party dependencies with no exploitable path in mqvi — report those
  upstream, though we appreciate being told
- Findings that require an already-compromised device, or a user knowingly installing a modified
  client
- Denial of service through raw traffic volume against a self-hosted instance
- Missing hardening that has no demonstrated impact (report it as a normal issue instead)
- Social engineering, physical access, or attacks on infrastructure we do not run

## Known design boundaries

These are deliberate, documented properties rather than vulnerabilities. Reports that a "flaw" here
exists will be closed as intended behaviour — but a report that one of them is **not actually true**
in the code is very much in scope.

- **Voice E2EE keys come from the server.** The per-room SFrame passphrase is generated server-side
  and handed to participants. This protects media from the SFU operator, not from the mqvi server.
  Messaging E2EE is different: those keys never leave the client.
- **Messaging E2EE is opt-in** per server or per DM, and the server enforces the policy for
  conversations that have it enabled.
- **Metadata is not encrypted.** Who talks to whom, when, and in which channel is visible to the
  server.
- **Self-hosted servers are trusted by their members** for anything not covered by E2EE.
- **A file token is long-lived by design** so in-app rendering survives a signed URL expiring. It is
  audience-scoped and cannot be replayed against the API — if you find a way to do so, that is a
  real vulnerability.

## Disclosure

Please give us a reasonable window to ship a fix before disclosing publicly. We are not going to put
a rigid number on it: something actively exploited moves in days, something theoretical can take
longer. Tell us your intended timeline and we will tell you if it is a problem.
