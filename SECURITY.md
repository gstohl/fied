# Security Audit Report

Audit date: 2026-02-15

Repository: `https://github.com/gstohl/fied`

Scope: `packages/relay`, `packages/cli`, `packages/web`, `packages/crypto`

## Executive Summary

The codebase has a solid baseline for confidentiality (AES-256-GCM, key in URL fragment, server-side frame-size/rate controls), but there are three meaningful security gaps:

1. Replay and message-type tampering are possible because protocol metadata is not authenticated and there is no replay protection.
2. Share URLs that include the encryption key fragment can be persisted locally in plaintext in background mode.
3. The relay accepts WebSocket upgrades without Origin enforcement, enabling cross-site connection abuse when a session ID is known.

## Findings

### 1) Missing replay protection and unauthenticated message type (Medium)

- Evidence:
  - Frame structure carries `type` outside encrypted payload (`packages/crypto/src/protocol.ts:4`, `packages/crypto/src/protocol.ts:37`, `packages/crypto/src/protocol.ts:56`).
  - AES-GCM is used without binding additional authenticated data (`packages/crypto/src/crypto.ts:71`, `packages/crypto/src/crypto.ts:88`).
  - Receivers do not track sequence numbers or reject duplicate frames (`packages/cli/src/index.ts:280`, `packages/web/src/connection.ts:124`).
- Impact:
  - A malicious or compromised relay can replay previously observed ciphertext frames.
  - A relay can flip frame `type` bytes to induce protocol misclassification/DoS behavior without breaking ciphertext authentication.
- Recommendation:
  - Bind `type` into AEAD integrity checks (e.g., AES-GCM `additionalData`) or move `type` into encrypted payload.
  - Add per-direction monotonic sequence numbers and reject duplicates/out-of-window frames.

### 2) Key-bearing share URLs persisted to disk in plaintext (Medium)

- Evidence:
  - Share URL is assembled with `#<key>` (`packages/cli/src/index.ts:235`).
  - In background mode, full URL is stored (`packages/cli/src/index.ts:98`, `packages/cli/src/store.ts:45`).
  - Stored URLs are shown in session management output (`packages/cli/src/bin.ts:89`).
  - Background mode also passes key in process args (`packages/cli/src/bin.ts:185`).
- Impact:
  - Any local user/process with read access to `~/.fied/sessions.json` (or process arguments) can recover the key while the session is active.
- Recommendation:
  - Do not persist key-bearing fragments in session metadata.
  - Store only non-secret session metadata (session ID + relay), and keep key material in memory or OS-protected storage.
  - Avoid passing key material via command-line arguments.

### 3) No Origin validation on WebSocket upgrade path (Low)

- Evidence:
  - Upgrade handling validates role and upgrade header, but not `Origin` (`packages/relay/src/index.ts:147`, `packages/relay/src/index.ts:487`).
- Impact:
  - Any website can initiate viewer WebSocket connections when session IDs are known; this enables cross-site abuse and resource/UX impact.
  - Confidentiality remains protected by encryption key handling, but connection abuse remains possible.
- Recommendation:
  - Enforce strict Origin allowlisting for browser viewer connections.
  - Consider a short-lived viewer join token in addition to session ID.

## Strengths Observed

- Strong cryptographic primitives and randomness usage (`AES-256-GCM`, Web Crypto RNG).
- Security-focused relay controls: frame-size caps, per-socket and session-creation rate limits, heartbeat timeouts.
- Defensive HTTP headers and CSP in relay responses (`x-content-type-options`, `x-frame-options`, `referrer-policy`, CSP).

## Prioritized Remediation Plan

1. Protocol hardening: authenticate message metadata and add replay defense.
2. Secret handling hardening: remove key fragment persistence and CLI arg exposure.
3. Relay boundary hardening: add Origin enforcement and optional viewer join token.

## References

- OWASP WebSocket Security Cheat Sheet
- OWASP Key Management Cheat Sheet
- NIST SP 800-57 (key management lifecycle)
