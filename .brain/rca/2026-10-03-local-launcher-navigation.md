# RCA — Local service launcher navigation rejected

Date: 2026-10-03 · C-2 · HIGH risk · Owner approved the concrete guard fix before implementation.

## Symptom

Zuri-Go's passive `noopener noreferrer` launcher opens `http://localhost:8788/` in a new tab, but Emar rejects the root document with HTTP 403. Direct navigation succeeds.

## Evidence

The disposable memory QA service recorded a cross-site `GET /` with no query, Referer, Authorization or cookie returning 403, while direct navigation with Fetch Site `none` returned 200. `src/http/server.mjs` applies `assertLocalRequest` before static UI delivery; `src/http/local-session.mjs` rejects supplied Fetch Site values other than `same-origin` and `none`. Pre-change source pins match the owner-reviewed proposal in `F:/zuri-go/.brain/rca/FEAT-013-emar-cross-site-navigation.md`. Unchanged standalone tests passed 7/7. No private configuration or existing SQLite state was inspected.

## Root Cause

The static root document uses the protected-request cross-site guard. The distinct loopback hostname needed for cookie separation is a cross-site navigation. `noreferrer` removes Referer but does not change Fetch Site, so the intended entry is denied.

## Why the issue escaped detection

The existing HTTP UI test omits Fetch Metadata and does not model a browser click from another host. The cross-site unit test covers a mutation rather than a static document entry.

## Proposed prevention / approved scope

Only the standalone root UI handler may opt into a cross-site exception for exact `GET /` without query and the full metadata tuple: Site `cross-site`, Mode `navigate`, Dest `document`, User `?1`. Loopback, local Host and supplied-Origin checks remain mandatory. The default guard, sessions, APIs, scripts/styles, mutations, MCP, integrated authorizer and OAuth callback keep their rules. Static root delivery issues no session cookie or data/provider operation. A user-initiated link from any source can meet this rule; Fetch Metadata is not an authenticated Zuri-Go identity. The owner explicitly accepted this tradeoff.

Add positive and negative guard/HTTP regressions, run relevant existing security/authorization suites, then verify the complete tuple and successful launcher click in an isolated memory browser QA process. If the browser lacks the tuple, report the mismatch without widening the rule. No real OAuth, provider send, database operation, deployment or release is authorized.

At the time of this RCA, six source/document baselines and their SHA-256 manifest were kept as local QA artifacts because the workspace had no Git repository. Those baselines and the source-only review patch are excluded from the public repository.

## Verification outcome

The full metadata tuple was observed on the actual Zuri-Go launcher click and root delivery returned 200; the real Emar UI loaded in a new tab. The first entry had no query, Referer, Authorization or cookie. Targeted suites passed 20/20, all external tests passed 81/81 and syntax checks passed for 22 modules. Zuri-Go launcher/package regressions passed 6/6 and 9/9 without source/build changes. Memory-only QA processes were stopped afterward. See [verification](../../docs/EMAR-0.3-VERIFICATION.md#owner-approved-local-launcher-navigation-fix--2026-10-03) for scope, file inventory and evidence limits. Persistent provider readiness, deployment and production were not inspected.
