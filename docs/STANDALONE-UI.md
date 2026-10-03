# Emar standalone UI — 0.3.0-beta.0

Emar serves a Thai local operator workspace at **http://127.0.0.1:8788/**. Use the configured callback host and port as shown under Settings → Gmail. Standalone mode is a single-operator local tool: local OS access is its trust boundary, and it is not a multi-user or Internet-facing login service.

## Local browser session

The browser session uses a random HttpOnly SameSite=Strict cookie, an eight-hour expiry, a per-session CSRF token, exact Origin validation, loopback peer validation, and a local Host allowlist. Mutations require CSRF and same-origin checks. Gmail OAuth callback uses its own short-lived HttpOnly SameSite=Lax cookie scoped to the fixed callback route; it is bound to one-time OAuth state and PKCE and does not turn a provider redirect into the regular browser session. MCP never accepts the standalone session.

The operator uses fixed `emailmar-local` tenant and business identifiers; callers cannot provide identities. If a host Identity authorizer is configured, standalone browser sessions are disabled.

Owner-approved local launcher fix (2026-10-03): the standalone static root document accepts cross-site `GET /` without query only when Fetch Metadata is `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, and `Sec-Fetch-User: ?1`. Loopback, local Host and supplied-Origin checks still apply. This supports a user-initiated top-level link from another local service without weakening session/API/mutation checks. The root response is static HTML and issues no session cookie; the UI opens its own same-origin session afterward. Other cross-site UI assets and protected requests remain denied. A link from any source can meet these navigation conditions; this does not identify or authenticate Zuri-Go. Direct navigation remains available when a browser does not supply the tuple. See [RCA](../.brain/rca/2026-10-03-local-launcher-navigation.md).

## Workspace data and actions

The default store is SQLite at `data/emar.sqlite`; the state survives process restarts. A single Emar process owns one database file at a time. The settings page reports the store mode. `EMAR_STORAGE=memory` is an explicit, temporary mode for tests and disposable fixtures.

The UI can create immutable template versions, enter contacts and explicit marketing consent, suppress contacts, register Files references, create and edit campaign drafts, inspect recipients and attachments, preview rendered content, approve a snapshot, schedule or pause a campaign, dispatch the selected campaign manually, and inspect reports and audit history. Missing, disconnected, or changed Gmail sender identity blocks dispatch before queue mutation. A sender change requires a fresh approval.

The Workflows page creates preparation DAGs with a label and one of three dependency presets. It shows run and node states, dependencies, worker identity, and fencing generation. The operator can pause and resume runs, recover interrupted nodes after resuming, and decide an explicit human gate. The UI never claims or completes worker nodes on their behalf; authorized integrations use the claim/complete API. Human gate decisions apply only to that workflow and cannot approve or send a campaign. No model runs automatically.

## Gmail connection

Settings shows only safe Gmail connection state, verified account email, scopes, missing environment field names, and the configured callback URI. It has no token, client-secret, or encryption-key input. To connect, configure Google OAuth Web application credentials in the Emar process environment, register the exact callback URI with Google, open Emar on the same local host/port, then press **Connect Gmail**. The user performs Google sign-in and consent in the browser. Emar does not read `.env` automatically; restart the process after environment changes.

The OAuth callback redirects only to a fixed Settings path and a fixed connected/cancelled/failed marker. Google error text, authorization code, OAuth state, and tokens are not echoed into the URL. Tests cover fixtures only; no live Gmail send is part of this release work.

Email previews sandbox scripts, forms, navigation, and remote resources. Email content itself is never run as browser code. The local UI has no external assets.

## Version diff

### Demo UI follow-up

The top-bar **Demo mode** toggle opens a separate browser-memory workspace with sample campaigns, recipients, consent and suppression, template versions, attachment references, activity and preparation DAGs. It starts off. Reset reloads the seed data; leaving demo returns to the real workspace. Reloading the page discards the simulation.

In demo mode, UI API requests are handled by a local mock router. Unknown mock routes fail rather than falling through to REST. Connect/disconnect, approval, scheduling, dispatch and tracking controls simulate changes only; they never perform Google navigation, call Gmail, write SQLite, or change the real connection. Email previews remain sandboxed. Demo open signals are image-request simulations, never human-read evidence.

The demo workflow control advances independent ready worker nodes in parallel steps. Human gates require an explicit click, and cannot approve or send a campaign. Pause, resume, interruption recovery and stop can be rehearsed. These controls are available only in demo mode; real workflows still require an authorized worker integration.

Switching modes closes open forms, clears the preview and returns to the campaign list. Responses from the previous mode cannot replace the current workspace. An already submitted real operation cannot be undone by switching to demo.

`0.3.0-beta.0` follow-up (package version unchanged): adds the isolated demo toggle and simulations. This is local UI behavior, not evidence of provider integration or production readiness.

`0.2.0-beta.0` → `0.3.0-beta.0`: Emar branding and workflow navigation, durable SQLite messaging, Gmail connect/disconnect controls and sender display, plus persistent DAG views and human gates. Fixed local scope IDs and existing standalone routes remain compatible.
