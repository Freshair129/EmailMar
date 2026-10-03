# Emar persistence, Gmail, and workflow integration — 0.3.0-beta.0

## Symptom

The 0.2.0-beta.0 service exposed EmailMar branding, stored all domain state in memory, had no local Google account connection flow, and did not persist execution workflow state. Restart cleared campaign and queue history, and Gmail dispatch could only work through a separately injected adapter.

## Evidence

- `src/domain/emailmar-service.mjs` defaulted to `InMemoryStore` and reported `persistence: in_memory`.
- `src/index.mjs` constructed the service without a store and logged `EmailMar` plus in-memory state.
- `src/http/server.mjs` had campaign REST/MCP routes but no Gmail connection or DAG routes.
- `src/ui/app.mjs` hardcoded an in-memory warning and `NOT_CONFIGURED` Gmail status.
- `docs/ARCHITECTURE.md` and `docs/STANDALONE-UI.md` explicitly described state as lost after restart.

## Root Cause

The starter was scoped as an in-memory campaign/API and local UI baseline. Durable storage, OAuth ownership, sender identity in approval snapshots, and dependency-aware execution state were outside that earlier implementation. No local-only routes or UI existed to manage those boundaries.

## Why the issue escaped detection

The earlier test suite covered isolated domain behavior, local sessions, and campaign routes using fixtures. It did not restart a persistent service, perform an OAuth callback, verify a Gmail account identity, or exercise execution graph state and fencing.

## Proposed prevention

Use SQLite as the default store and require explicit `EMAR_STORAGE=memory` for disposable tests. Keep one process owner per database, checkpoint state before provider effects, recover uncertain sends as `SEND_UNKNOWN`, and surface storage failures as unhealthy. Bind Gmail OAuth to the local browser and one-time PKCE state, encrypt tokens, pin the verified sender in each approval snapshot, and recheck identity plus campaign eligibility immediately before Gmail I/O. Persist tenant-scoped DAG state with dependency checks, worker fencing, explicit pause/recovery, and human-only gates. Verify these paths with restart, route, OAuth fixture, delayed-token, and DAG tests. Live Google consent and real email delivery remain outside fixture evidence.

## Local configuration helper startup RCA

### Symptom

The Windows `Start` action failed before launching Emar, even though `Configure` and `Status` completed successfully.

### Evidence

- The Windows user reported that the credential vault was protected and created successfully.
- `Get-Command node -CommandType Application` returned two executable results, including the installed Node.js path and a bundled runtime path.
- The helper assigned that multi-result collection directly, then passed its `.Source` value to PowerShell's call operator; Start therefore received an array where it expected one executable.

### Root Cause

The helper did not select a single Node.js executable before invoking it. PowerShell's command lookup can return multiple applications when more than one Node.js runtime is on `PATH`.

### Why the issue escaped detection

The helper had only received parser validation before the Windows user's first Start attempt. Configure and Status do not resolve or launch Node.js, so they could not expose the multi-result command lookup.

### Proposed prevention

Select one executable explicitly, check its version is at least 22.13.0 before passing credentials to the application process, and keep the child process environment scoped and restored. Continue to keep client secrets and encryption keys out of helper output. The helper fix was syntax-checked only; no second Start was run as part of this remediation.
