# Emar 0.3.0b verification

Date: 2026-09-24. Scope: local implementation and fixture evidence. This document does not certify a live Gmail connection, email delivery, or production deployment.

## Version change

`0.2.0-beta.0` → `0.3.0-beta.0`: public name Emar, SQLite persistence, encrypted Gmail OAuth connections, approval sender identity, durable execution DAG and standalone UI controls. Existing directory, fixed local scope identifiers and compatibility exports remain.

## Development gates

- Luna Max workers owned separate storage/DAG, OAuth/security, and REST/UI integration paths.
- Terra performed an architecture review and a separate source review. The source review received only numbered source and the implementation contract; it did not receive credentials or database contents.
- The first Terra source review blocked on globally keyed user-supplied DAG IDs. The storage worker implemented composite tenant/business/run keys and regression tests, plus audited migration of schema 1 snapshots to schema 2.
- Terra also proposed tenant-specific quotas. The orchestrator rejected that proposal: the service-wide 500-message UTC-day ceiling is intentional and covered by the original acceptance test. Tenant-specific quota pools would weaken that ceiling.
- Orchestrator findings returned to workers included stale PID-lock races, checkpoint serialization failures, approval capture across awaits, human stop fencing, OAuth scope aliases, storage-health checks, the UTC-midnight preflight boundary, and the public DAG stylesheet route.

Terra's final source recheck returned **PASS: both prior findings resolved**. Its review was source-only; it did not run the tests. The collaboration tool could not restore the original reviewer because of its thread limit, and the first CLI reviewer could not run its nested shell. The successful CLI review therefore received the explicitly allowed numbered source through stdin and performed no tool calls. Both CLI reviews used `gpt-5.6-terra`; no application runtime model was added.

The orchestrator final gate is **PASS for the bounded local implementation**, after reviewing the fixes, running the complete test suite, checking syntax, and inspecting the UI. External configuration and production evidence remain limited as listed below.

## Final commands

Runtime: Node.js 24.19.0, Windows. Run from `the local EmailMar checkout`.

| Command | Result |
|---|---|
| `npm test` | Exit 0; 64 tests passed, 0 failed, 0 skipped |
| `npm run check` | Exit 0; syntax OK for 19 JavaScript modules |
| `npm start` | Emar 0.3.0-beta.0 started on `127.0.0.1:8788` with SQLite |
| `GET /health` | `status: ok`, `service: emar`, `persistence: sqlite`, `gmail: NOT_CONFIGURED`, `dailyLimit: 500`, `authentication: local_session` |

The 64 tests include the original 24 acceptance tests, 13 OAuth/security tests, 17 storage/DAG tests, and 10 HTTP/adapter integration tests. One intermediate integration test failed because its callback mock captured a shadowed fixture variable; the variable binding was corrected while retaining the callback security assertion. The final combined run above passed.

## Browser evidence

An isolated service ran on `127.0.0.1:8790` using a temporary SQLite store with Gmail configuration explicitly absent. Browser checks confirmed:

- Emar branding and SQLite persistence status.
- Gmail missing configuration names and fixed callback URI; connect disabled while `NOT_CONFIGURED`.
- Creating a six-node preparation DAG from the UI.
- The same run ID and dependency states remained after stopping and restarting the service against the same SQLite file.
- The existing run remained available after the schema 1 to 2 scoped-key migration.
- Pause and resume buttons updated the run state correctly; the DAG stylesheet rendered the individual node cards.

These are local UI/database observations, not live Google authentication evidence. The verification fixture is separate from the user's service database.

Before replacing the previous in-memory service on port 8788, the orchestrator verified that its campaign list and mutation history were empty. The main UI was then reloaded and showed Emar, SQLite and Gmail setup fields at `http://127.0.0.1:8788/#settings`. The isolated test service was stopped and its tab closed. The main service was left running; its database is `data/emar.sqlite`.

## Files created or changed

| Area | Files |
|---|---|
| Durable domain | `src/domain/store.mjs`, `src/domain/emailmar-service.mjs`, `src/domain/execution-dag.mjs` |
| Google connection | `src/integrations/gmail-oauth.mjs`, `src/security/gmail-token-vault.mjs`, `src/adapters/gmail-api.mjs` |
| Startup and HTTP | `src/index.mjs`, `src/http/server.mjs`, `src/http/local-session.mjs`, `src/http/ui-assets.mjs` |
| Standalone UI | `src/ui/index.html`, `src/ui/app.mjs`, `src/ui/dags.css` |
| Configuration | `package.json`, `.gitignore`; local configuration sample omitted from public snapshot |
| Tests | `test/storage.test.mjs`, `test/dag.test.mjs`, `test/oauth-gmail-connections.test.mjs`, `test/integration-routes.test.mjs` |
| Documentation | `README.md`, `docs/ARCHITECTURE.md`, `docs/ZURI-INTEGRATION.md`, `docs/STANDALONE-UI.md`, `docs/GMAIL-OAUTH.md`, `docs/STORAGE-DAG.md`, `docs/EMAR-0.3-IMPLEMENTATION.md`, this report |
| RCA | `.brain/rca/2026-09-24-durable-storage-send-recovery.md`, `.brain/rca/2026-09-24-emar-integration.md` |

The workspace is not a Git repository, so this is a path inventory rather than a Git diff or commit claim. No Zuri repository files were changed.

## External configuration boundary

| Component | Status |
|---|---|
| SQLite persistence and DAG state | Implemented; local fixture and browser restart evidence |
| Gmail OAuth client and encryption-key injection | `NOT_CONFIGURED` in the verified local runtime |
| Live Google sign-in / Gmail send | `NOT_RUN`; user must configure the client and complete Google consent |
| Zuri JWT / trusted membership authorizer | `NOT_CONFIGURED`; standalone mode uses the local operator session |
| Files binary resolver | `NOT_CONFIGURED`; attachment metadata remains a reference to its owner |
| Gmail Pub/Sub / provider reconciliation integration | `NOT_CONFIGURED` |
| PostgreSQL / distributed queue | `NOT_CONFIGURED`; this version uses one SQLite owner process |
| Public tracking host / deployment / production readiness | `NOT_CONFIGURED` / not established |
| Runtime LLM | Intentionally outside scope; Luna and Terra were development agents |

## Local OAuth configuration follow-up — 2026-09-24

At the user's request, the existing Google Web OAuth client JSON in Downloads was imported programmatically without displaying its credential values. `scripts/local-config.ps1` was added to protect the local configuration with Windows current-user DPAPI at `%LOCALAPPDATA%\Emar\credentials.dpapi`. A new 32-byte encryption key was created on initial configuration. Future Configure runs retain that key.

- `Configure`: exit 0, protected credentials saved; no secret values in output.
- `Status`: exit 0, all four required environment field names reported configured.
- `Start`: the first invocation exposed duplicate Node executable discovery; this was corrected to select one executable and validate Node >=22.13. The corrected invocation started the existing SQLite service successfully.
- Final PowerShell parser validation: passed. This follow-up did not rerun the unchanged JavaScript test suite; the 64/64 result above belongs to the preceding implementation gate.
- Live browser: Gmail status changed from `NOT_CONFIGURED` to `DISCONNECTED`, and Connect Gmail became enabled.

The downloaded client metadata listed a Supabase callback. The current Google Cloud redirect registration has not been verified; the user must add/confirm `http://127.0.0.1:8788/v1/integrations/gmail/callback` while preserving existing callbacks. Google Cloud was opened at sign-in for the user. Live Google account authorization and email sending remain `NOT_RUN`.

Additional changed files: `scripts/local-config.ps1`, `README.md`, `docs/GMAIL-OAUTH.md`, this report, `.brain/rca/2026-09-24-local-config-node-selection.md`, and the integration RCA note. The application version remains 0.3.0-beta.0; this follow-up adds the Windows configuration/start helper and changes local configuration status.

## Owner-approved local launcher navigation fix — 2026-10-03

Complexity C-2; risk HIGH. Approval covers the narrow root-document guard exception, regression tests and disposable Memory browser QA described in [RCA](../.brain/rca/2026-10-03-local-launcher-navigation.md), separately from Zuri-Go FEAT-013. No existing data, private configuration, credentials or provider operations were involved.

The standalone root handler now explicitly opts into a cross-site exception only for exact `GET /` with no query and Site `cross-site`, Mode `navigate`, Dest `document`, User `?1`. Peer/Host/Origin checks remain mandatory. The default session/API/static-asset guard, cookies, CSRF, integrated authorizer, MCP and OAuth callback behavior remain unchanged. Fetch Metadata is not source authentication: a user-initiated link from any source can qualify under local-OS trust.

| Command/check | Result |
|---|---|
| New regression suite before fix | 8/10 passed, 2 root-navigation positives failed |
| `node --test test/standalone.test.mjs test/integration-routes.test.mjs` after fix | 20/20 PASS |
| `node --test test/*.test.mjs` | 81/81 PASS, fixture-only providers/storage |
| `npm run check` | PASS, 22 JavaScript modules |
| Real click from Zuri-Go `127.0.0.1:4319` to fixed `localhost:8788/` | PASS, new tab, root HTTP 200, complete metadata tuple, actual Thai UI loaded |
| First navigation query / Referer / Authorization / cookie | All absent; only presence flags were logged |
| Settings in disposable QA | Memory storage, Demo OFF; Gmail / Files / Zuri Identity NOT_CONFIGURED |
| Cleanup | Task-owned processes stopped; no 4319/8788 listener remained |

Node fetch overrides `Sec-Fetch-Mode` with `cors`, so the new HTTP fixture uses raw HTTP to preserve the browser tuple. Guard conditions were not weakened to accommodate that test transport. The actual browser supplied the complete tuple. Static navigation is also tested with a service-access trap and must issue no session cookie or CORS permission.

Changed files: `src/http/local-session.mjs`, `src/http/server.mjs`, `test/standalone.test.mjs`, `docs/STANDALONE-UI.md`, `docs/ARCHITECTURE.md`, this record, and `.brain/rca/2026-10-03-local-launcher-navigation.md`. Pre-change copies, the SHA-256 manifest, the baseline test and the source-only patch were local QA artifacts and are excluded from the public repository. At the time of verification, this workspace had no Git repository, so no commit or push was claimed.

Version diff: Emar remains `0.3.0-beta.0`; cross-site launcher loading changed from HTTP 403 to HTTP 200 in Memory QA. Existing persistent provider readiness, live Gmail, OAuth consent, deployment and production remain unverified. The earlier configured-runtime notes above are historical evidence, not a fresh inspection in this task. The successful UI screenshot is `F:/zuri-go/build/emar-launcher-qa-2026-10-03.png`.

Source-only patch reverse applicability and whitespace checks passed; documentation/RCA paths resolve. The stopped-service browser inventory showed an unavailable destination and the already loaded Zuri-Go guide still navigated. Detailed inspection of the browser-generated `data:` error page was blocked by browser policy and was not worked around. A later unrelated Node listener appeared on 4319 after the task's Python preview stopped; it was preserved. Emar QA remained stopped, with no listener on 8788.
