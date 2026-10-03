# Emar 0.3.0-beta.0

Emar is a local email execution service with explicit human approval, encrypted Gmail OAuth tokens, durable SQLite state, and a dependency-aware execution DAG. It does not call an LLM at runtime. Luna Max and Terra refer to the development reviewers only.

## Run locally

Requires Node.js 22.13 or newer for the built-in SQLite API.

```sh
npm test
npm run check
npm start
```

Open the canonical local address **http://127.0.0.1:8788/**. The Thai UI works without Zuri. It stores drafts, contacts, campaign approvals, queue state, audit history, Gmail connection records, and DAG runs in `data/emar.sqlite` by default. The service takes an exclusive process lock for that database file; this release does not run a distributed multi-host queue. Use `EMAR_STORAGE=memory` only for disposable fixtures.

Back up the SQLite database and Gmail token encryption key under separate access controls. The key is required to decrypt saved OAuth tokens; never store the key beside the database. Database files, WAL files, locks, `.tmp/`, and local `.env` files are ignored by Git.

## Connect Gmail

Create a Google OAuth Web application client and register the callback URI shown in **Settings → Gmail**. The default is `http://127.0.0.1:8788/v1/integrations/gmail/callback`; open the UI using the same `127.0.0.1` host and port. Provide these names in Emar's process environment:

- `EMAR_GOOGLE_CLIENT_ID`
- `EMAR_GOOGLE_CLIENT_SECRET`
- `EMAR_GOOGLE_REDIRECT_URI`
- `EMAR_TOKEN_ENCRYPTION_KEY` — 64 hexadecimal characters representing 32 random bytes

`.env` files are not loaded automatically. Restart Emar after changing its process environment. Settings shows missing field names and the callback URI, never secret values. The user starts Google sign-in by pressing **Connect Gmail** and completes consent in the browser. Local implementation and fixture tests are not live Gmail connection or delivery evidence; no real email is sent by the test suite.

On Windows, `scripts/local-config.ps1 -Action Configure -ClientJsonPath '<downloaded client JSON path>'` can import an existing Web OAuth client and create a token-encryption key in a current-user DPAPI vault. Then use `scripts/local-config.ps1 -Action Start` to launch Emar with that protected configuration. Reconfiguration preserves the encryption key. See [Windows local configuration](docs/GMAIL-OAUTH.md#windows-local-configuration); plain `npm start` does not load the vault.

Emar requests only the identity needed to verify the Gmail account and Gmail send permission. The encrypted token bundle is scope-bound and protected with AES-256-GCM. Connecting a different account requires an explicit disconnect; changing the connected sender requires a new human approval of each campaign snapshot.

## Workflows and campaign safety

The **Workflows** page creates and tracks preparation DAGs with dependency states, worker claims, fencing generations, pause/resume, and explicit human gates. Worker claim/complete routes are available to integrations authorized with `dag.worker`. A DAG human gate does not approve a campaign or send email. The UI does not simulate LLM output or mark worker nodes complete automatically.

Campaign approval pins the connected Gmail sender identity into the immutable snapshot. Dispatch refuses a missing, disconnected, or changed sender before consuming the queue. Consent and suppression are checked again immediately before the Gmail request. Ambiguous Gmail outcomes become `SEND_UNKNOWN` and are not retried automatically.

## Zuri integration and compatibility

Set `EMAR_ADAPTER_MODULE` to a local ES module exporting `createEmailMarAdapters({ service, createGmailApiAdapter })`; the legacy `EMAILMAR_ADAPTER_MODULE` name remains accepted. The module may return a trusted request authorizer and Files adapter. Supplying an Identity authorizer disables standalone browser sessions. Fixed local scope IDs and the existing `emailmar` module paths/export names remain for compatibility.

Legacy `EMAILMAR_DAILY_LIMIT` and `EMAILMAR_PUBLIC_BASE_URL` variables remain accepted. See [architecture](docs/ARCHITECTURE.md), [Zuri integration](docs/ZURI-INTEGRATION.md), and [standalone UI](docs/STANDALONE-UI.md) for route permissions and operational boundaries.

## Version change

`0.2.0-beta.0` → `0.3.0-beta.0`: EmailMar renamed to Emar, Node.js minimum raised to 22.13, SQLite made the default, Gmail OAuth and sender pinning added, and execution DAG persistence/UI added. The existing `emailmar` directory and legacy environment/module seams remain.
