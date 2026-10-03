# Standalone UI verification — 2026-09-24

Version: `0.1.0-beta.0` → `0.2.0-beta.0`. Evidence is local only.

## Changed files

New:

- `src/ui/index.html`, `src/ui/styles.css`, `src/ui/app.mjs`: standalone Thai workspace and forms.
- `src/http/local-session.mjs`: local operator session, CSRF, Origin, Host and loopback checks.
- `src/http/ui-assets.mjs`: static assets and restrictive content security policy.
- `test/standalone.test.mjs`: seven additional session, scope, queue, dispatch and HTTP workflow tests.
- `docs/STANDALONE-UI.md`, `docs/VERIFICATION.md`: operation, scope and evidence.
- `.brain/rca/2026-09-24-ui-create-navigation.md`: UI routing findings; standalone execution gates are described in [STANDALONE-UI.md](STANDALONE-UI.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

Updated:

- `src/index.mjs`: local UI startup and loopback enforcement.
- `src/http/server.mjs`: local sessions and scoped REST CRUD/dispatch endpoints.
- `src/domain/emailmar-service.mjs`: workspace projection, display names, selected-campaign dispatch, post-attachment eligibility checks, advancing-clock scheduling and repeated schedule behavior.
- `package.json`: beta version.
- `README.md`, `docs/ARCHITECTURE.md`, `docs/ZURI-INTEGRATION.md`: standalone operation and integration boundaries; local configuration examples are excluded from the public snapshot.

## Automated verification

- `npm test`: **24 passed, 0 failed, 0 skipped** using `node:test` and fixture Gmail adapters.
- `npm run check`: **Syntax OK: 12 JavaScript modules**.
- Commands completed using the Windows command shell. Earlier PowerShell launches stalled before producing output and were stopped; those attempts are not counted as passing checks.
- Test coverage includes cross-tenant/business denial, consent and suppression, human-only approval and local dispatch, approval invalidation, scoped REST/MCP authorization, duplicate worker claims, daily cap, Gmail timeout without retry, tracking semantics, local session/CSRF/Host/Origin checks, idempotent scheduling with an advancing clock, missing adapter preservation and eligibility changes during asynchronous attachment resolution.

## Browser verification

An isolated in-memory service at port 8790 was used for fictional data, separate from the user's UI at port 8788:

1. Created a template with subject, plain text, generated HTML and `{{name}}`.
2. Created `demo@example.invalid` with a fictional consent record; the UI initially left consent unchecked.
3. Selected that recipient in a campaign and verified the per-recipient variable field.
4. Saved a draft and verified personalized subject and sandboxed HTML preview, recipient summary, empty attachments and separate signal counts.
5. Verified approval and scheduling buttons were disabled initially and Gmail showed `NOT_CONFIGURED`.
6. After correcting a hash-navigation race, created a copy with a changed variable and verified automatic navigation to its new detail URL and the changed personalized preview.
7. Browser error/warning log for the isolated session was empty.

No campaign was approved or sent through browser automation. Approval/scheduling/dispatch behaviors were tested against isolated domain/HTTP fixtures. The temporary browser and fixture server were closed and the temporary launcher was removed. The user's independent UI remains at `http://127.0.0.1:8788/`.

## Remaining configuration and limitations

`NOT_CONFIGURED`: Gmail OAuth, Files byte resolver, Zuri JWT, Pub/Sub, PostgreSQL and deployment. Gmail MCP read/draft integration is not wired; no Gmail MCP send capability is claimed.

All state, including audit, consent, suppression, queue history and idempotency records, is in memory and is lost on process restart. There is no background dispatch scheduler, remote login or durable multi-process coordination. The UI relies on the local OS access boundary. Live Gmail sending, production delivery and production readiness are **not proven**.

The Zuri repository was used read-only; this UI change does not modify it. Browser verification used fictional data and did not connect to Gmail or dispatch a campaign.
