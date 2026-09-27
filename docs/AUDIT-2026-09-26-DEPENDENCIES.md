# Backend dependency audit — 2026-09-26 audit refactor

Scope: production dependencies of the API (repo root, not `web/`).
Command: `npm audit --omit=dev --json` against `package-lock.json` on branch
`audit/edge` (run 2026-09-27, read-only: no `npm install`, no `npm audit fix`,
no `package.json` or lockfile change).

Result: **8 vulnerable packages** (0 critical, 3 high, 4 moderate, 1 low) out
of 98 production dependencies. Every one has a fix inside the ranges
`package.json` already declares (`fixAvailable: true`), so a lockfile refresh
closes all of them without a major bump.

## Summary

| Package | Installed | Severity | Direct? | Pulled in by | Fixed in |
| --- | --- | --- | --- | --- | --- |
| hono | 4.12.16 | high | yes | — | >= 4.13.5 (latest 4.13.9) |
| fast-uri | 3.1.2 | high | no | claude-agent-sdk → @modelcontextprotocol/sdk → ajv | >= 3.1.6 |
| ip-address | 10.2.0 | high | no | claude-agent-sdk → @modelcontextprotocol/sdk → express-rate-limit | > 10.3.0 (latest 10.7.2) |
| @hono/node-server | 2.0.1 (root), 1.19.14 (nested under @modelcontextprotocol/sdk) | moderate | yes | — / @modelcontextprotocol/sdk | >= 2.0.10 on 2.x; >= 1.19.15 on 1.x (latest 2.1.1) |
| @anthropic-ai/claude-agent-sdk | 0.2.138 | moderate | yes | — (flagged via @anthropic-ai/sdk) | >= 0.2.141 (depends on sdk ^0.93.0) |
| @anthropic-ai/sdk | 0.81.0 | moderate | no | claude-agent-sdk | >= 0.91.1 |
| qs | 6.15.1 | moderate | no | claude-agent-sdk → @modelcontextprotocol/sdk → express, body-parser | >= 6.16.0 |
| body-parser | 2.2.2 | low | no | claude-agent-sdk → @modelcontextprotocol/sdk → express | >= 2.3.0 |

## Advisories

### hono 4.12.16 (high) — fixed in 4.13.5

| Advisory | Severity | Affected | Title |
| --- | --- | --- | --- |
| GHSA-88fw-hqm2-52qc | high | < 4.12.25 | CORS middleware reflects any Origin with credentials when `origin` defaults to the wildcard |
| GHSA-qp7p-654g-cw7p | moderate | < 4.12.18 | CSS declaration injection via style object values in JSX SSR |
| GHSA-hm8q-7f3q-5f36 | low | < 4.12.18 | Improper validation of NumericDate claims in JWT `verify()` |
| GHSA-p77w-8qqv-26rm | moderate | < 4.12.18 | Cache middleware ignores `Vary: Authorization` / `Vary: Cookie` |
| GHSA-xrhx-7g5j-rcj5 | moderate | < 4.12.21 | IP Restriction bypass for non-canonical IPv6 |
| GHSA-3hrh-pfw6-9m5x | moderate | < 4.12.21 | Cookie helper does not sanitize sameSite / priority |
| GHSA-f577-qrjj-4474 | moderate | < 4.12.21 | JWT middleware accepts any Authorization scheme |
| GHSA-2gcr-mfcq-wcc3 | moderate | < 4.12.21 | `app.mount()` strips prefix using the undecoded path |
| GHSA-rv63-4mwf-qqc2 | moderate | < 4.12.25 | Body Limit bypass on AWS Lambda via understated Content-Length |
| GHSA-wgpf-jwqj-8h8p | moderate | < 4.12.25 | Lambda@Edge adapter keeps only the last repeated header |
| GHSA-wwfh-h76j-fc44 | moderate | < 4.12.25 | serve-static path traversal on Windows (`%5C`) |
| GHSA-j6c9-x7qj-28xf | moderate | < 4.12.25 | AWS Lambda adapter merges Set-Cookie headers |
| GHSA-xgm2-5f3f-mvvc | moderate | >= 4.3.3 < 4.12.27 | API Gateway v1 adapter drops repeated header values |
| GHSA-hvrm-45r6-mjfj | moderate | >= 4.11.8 < 4.12.27 | hono/jsx context not isolated per request |
| GHSA-w62v-xxxg-mg59 | moderate | >= 4.0.0 < 4.12.27 | Server-side XSS via JSX escaping bypass in `cx()` |
| GHSA-8j4g-w8fx-2239 | moderate | < 4.12.34 | ReDoS in CORS middleware via Access-Control-Request-Headers |
| GHSA-f23p-vx2j-j53r | moderate | >= 3.8.0 < 4.12.34 | `memo()` retains SSR output across requests |
| GHSA-79qm-7rj5-m7r9 | low | >= 4.7.0 < 4.12.34 | Proxy helper keeps headers listed in `Connection` |
| GHSA-54fx-42gc-7vw4 | moderate | >= 4.12.0 < 4.12.34 | Algorithmic-complexity DoS in Language middleware |
| GHSA-gqvv-2mrq-wpjv | moderate | < 4.13.5 | `toSSG()` writes outside the output directory (incomplete fix) |
| GHSA-g6gw-c38x-mqfc | moderate | < 4.13.5 | Unbounded dot-notation nesting in `parseBody()` |
| GHSA-crvj-82cr-hjcx | moderate | < 4.13.5 | Query parser reads parameters after the URL fragment |

Exposure: the API imports only `hono` core and `hono/body-limit` (no CORS, JWT,
cache, cookie, IP-restriction, language, JSX, SSG, proxy or Lambda adapters) and
runs on Linux under `@hono/node-server`. Most advisories hit code paths this
app does not load. The ones on core paths are the query parser
(GHSA-crvj-82cr-hjcx; HTTP clients do not send the fragment) and `parseBody()`
(GHSA-g6gw-c38x-mqfc; the API reads JSON bodies, not form bodies). Low direct
exposure, but it is the one direct dependency with a high advisory, so bump it
first.

### fast-uri 3.1.2 (high) — fixed in 3.1.6

GHSA-v2hh-gcrm-f6hx, GHSA-7p8r-x3mc-p8w7, GHSA-jqff-g426-hqxp, GHSA-4c8g-83qw-93j6
(host confusion); GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf (SSRF via malformed
IPv6 / repeated percent-decoding). All high.

Exposure: reached only through `ajv`, which the MCP SDK uses to validate tool
JSON schemas. Sage's router uses an in-process SDK MCP server with fixed
schemas; no user-supplied URI reaches it.

### ip-address 10.2.0 (high) — fixed after 10.3.0

GHSA-mwp4-54f8-5fhr (high: leading-zero octets decoded as decimal, SSRF /
trust-boundary bypass); GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg (moderate:
CIDR suffix and IPv4-mapped/NAT64 misclassification).

Exposure: reached only through `express-rate-limit` in the MCP SDK's HTTP
transport, which the in-process Sage MCP server does not start. The API's own
rate limiter (`src/api/middleware/rate-limit.ts`) does not use it.

### @hono/node-server 2.0.1 / 1.19.14 (moderate)

| Advisory | Severity | Affected | Title |
| --- | --- | --- | --- |
| GHSA-frvp-7c67-39w9 | moderate | < 1.19.15; >= 2.0.0 < 2.0.5 | serve-static path traversal on Windows (`%5C`) |
| GHSA-9mqv-5hh9-4cgg | moderate | >= 2.0.0 <= 2.0.9 | Unauthenticated memory-leak DoS via aborted WebSocket handshake |

Exposure: `scripts/serve.ts` uses only `serve` (no serve-static, no WebSocket
upgrade) on Linux. Low.

### @anthropic-ai/sdk 0.81.0 via @anthropic-ai/claude-agent-sdk 0.2.138 (moderate)

GHSA-p7fg-763f-g4gf (>= 0.79.0 < 0.91.1): insecure default file permissions in
the local-filesystem Memory tool. Fixed by claude-agent-sdk >= 0.2.141, which
depends on `@anthropic-ai/sdk ^0.93.0`.

Exposure: the API does not import `@anthropic-ai/sdk` directly or enable the
Memory tool. Low.

### qs 6.15.1 (moderate) — fixed in 6.16.0

GHSA-q8mj-m7cp-5q26 (DoS in `qs.stringify` with comma-format arrays),
GHSA-x5fp-wj9c-mxmx (array-limit bypass), GHSA-4mjr-xmp4-gh2g (DoS via
attacker-controlled `isBuffer`).

### body-parser 2.2.2 (low) — fixed in 2.3.0

GHSA-v422-hmwv-36x6: an invalid `limit` value silently disables size
enforcement.

Exposure (qs, body-parser): both come in with `express` inside the MCP SDK's
HTTP transport, which the in-process Sage MCP server does not start. The API
parses its own requests with Hono. Low.

## Recommendation (operator)

All 8 close with a lockfile refresh inside the declared ranges. Do it in a
maintenance window, since it changes the modules the live `denue-analyzer` unit
loads:

1. `hono` to ^4.13.5 and `@hono/node-server` to ^2.0.10 (direct).
2. `@anthropic-ai/claude-agent-sdk` to >= 0.2.141. This also pulls in
   `@anthropic-ai/sdk` ^0.93.0 and a newer `@modelcontextprotocol/sdk` tree.
   Re-run the Sage provider tests, because the SDK drives the router.
3. Re-run `npm audit --omit=dev` and expect 0, then `npx tsc --noEmit` and the
   API test files.

This package does not do this upgrade (no dependency or lockfile edits).

## Stale root `dist/` (operator cleanup)

The main checkout has an untracked root `dist/` (`dist/src`, `dist/scripts`;
every file dated 2026-05-13). It is ignored by `.gitignore` (`dist/`), so git
never reports it. Nothing uses it: the `denue-analyzer` unit runs
`npx tsx --env-file=.env scripts/serve.ts` straight from source, and
`denue-matview-refresh` runs `scripts/refresh-matviews.sh`. The leftover
`"main": "dist/index.js"` in `package.json` is not read by either unit. A stale
compiled copy of the API is a trap for anyone who runs `node dist/...` and gets
four months of old code (pre-P04 auth, rate limits and analytics runner).

Operator step (main checkout, not a worktree):

```
rm -rf /root/claude/projects/data-intelligence/denue-data-analysis/dist
```

## Repo hygiene

`web/.claude/` (qa-auditor agent memory that Claude Code sessions write into the
SPA tree) was untracked but not ignored. It is now in `.gitignore`.
