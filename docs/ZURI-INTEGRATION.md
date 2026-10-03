# Zuri integration contract — Emar 0.3.0-beta.0

Emar is a separate local service. Zuri repositories are not modified by this implementation. Public runtime/package branding is Emar; source paths and legacy environment names under `emailmar` remain compatibility seams.

## REST and MCP

REST defaults to `HOST:PORT=127.0.0.1:8788`. `GET /health` is unauthenticated and reports service version and storage mode. The principal campaign routes are:

| Route | Permission and behavior |
|---|---|
| `GET /v1/workspace` | `campaign.read`, `template.read`, `crm.read`, and `files.read`; scoped workspace and recent audit events. |
| `POST /v1/campaigns` | `campaign.write`; body includes name, template id/version and CRM recipient IDs. Scope comes from Identity. |
| `POST /v1/campaigns/:id/preview` | `campaign.read`; returns rendered sample, eligibility counts, and draft hash. |
| `POST /v1/campaigns/:id/approve` | Human actor plus `campaign.approve`; accepts the current preview hash. Approval snapshots pin the Gmail connection identity. |
| `POST /v1/campaigns/:id/schedule` | `campaign.schedule`; refuses missing or stale approval and reserves durable daily quota. |
| `POST /v1/campaigns/:id/pause` | `campaign.pause`; cancels queue entries that have not started. |
| `POST /v1/campaigns/:id/dispatch` | Human plus `campaign.worker`; selected campaign only, and requires the pinned Gmail sender before changing queue state. |
| `GET /v1/campaigns/:id/report` | `campaign.read`; returns provider acceptance and separate observed event signals. |
| `GET /v1/tracking/open/:token.gif` | Opaque-token pixel; emits `open_signal`, never `read`. |
| `GET /v1/tracking/click/:token` | Opaque-token redirect for an approved HTTP(S) URL. |
| `GET /v1/tracking/unsubscribe/:token` | Returns a confirmation form; it does not suppress on link-preview/prefetch GETs. |
| `POST /v1/tracking/unsubscribe/:token` | Applies suppression (including RFC 8058 one-click POST). |

`POST /mcp` implements JSON-RPC `initialize`, `tools/list`, and `tools/call` for campaign draft creation, preview, scheduling of already approved snapshots, pause, and reports. REST and MCP share the same Identity authorizer and domain permission checks. MCP has no campaign approval or dispatch tool and does not accept standalone browser sessions. The DAG API is REST-only in this release.

Tenant/business IDs in request payloads are rejected. The host Identity adapter returns a trusted context such as:

```js
{
  tenantId: 'resolved-tenant-uuid',
  businessId: 'authorized-business-uuid',
  actorId: 'resolved-principal-id',
  actorType: 'human', // or 'agent' / 'service'
  permissions: ['campaign.read', 'campaign.write', 'campaign.approve', 'campaign.schedule']
}
```

The executable starter has no JWT verifier. Its default local UI uses a loopback-only session for REST; `/mcp` continues to fail closed with `401` until the host wires an authorizer. Set `EMAR_ADAPTER_MODULE` (legacy `EMAILMAR_ADAPTER_MODULE` is still accepted) to a local ES module exporting `createEmailMarAdapters({ service, createGmailApiAdapter })` and returning `{authorizeRequest, gmail, files}`. Supplying `authorizeRequest` disables standalone browser sessions. Never treat caller-supplied headers as a trusted production identity.

## Gmail OAuth routes

| Route | Permission and behavior |
|---|---|
| `GET /v1/integrations/gmail/status` | `integration.read`; safe status, verified email/scopes where connected, and missing environment field names. |
| `POST /v1/integrations/gmail/connect` | Human plus `integration.write`, CSRF, and exact configured callback Origin; returns a Google authorization URL and sets the short-lived callback-binding cookie. |
| `GET /v1/integrations/gmail/callback` | Fixed local callback; validates the configured loopback Host and Lax cookie, then consumes one-time OAuth state/PKCE. Redirects only to a fixed Settings path with a fixed safe outcome marker. |
| `POST /v1/integrations/gmail/disconnect` | Human plus `integration.write` and CSRF; deletes the scoped encrypted connection. |

Configure `EMAR_GOOGLE_CLIENT_ID`, `EMAR_GOOGLE_CLIENT_SECRET`, `EMAR_GOOGLE_REDIRECT_URI`, and a 64-character hexadecimal `EMAR_TOKEN_ENCRYPTION_KEY` (32 random bytes). The default callback is `http://127.0.0.1:8788/v1/integrations/gmail/callback`. Register that exact URI in Google Cloud and use the matching local host/port in the browser. `.env` is not auto-loaded. Missing configuration is returned as field names only; no secret or provider error text is returned to the browser.

OAuth state is server-owned, one-time, PKCE-bound, browser-bound, and expires in ten minutes. Token bundles use AES-256-GCM and authenticated tenant/business scope. A connected sender is pinned into the campaign approval snapshot. Account switching requires explicit disconnect; sender change or reconnection requires fresh campaign approval. Token refresh preserves connection identity and the pre-request synchronous fence rechecks current consent/suppression and campaign state immediately before Gmail I/O.

## Execution DAG routes

Runs and nodes are tenant/business scoped and stored in the durable database. Node kinds are `draft`, `subject`, `segmentation_suggestion`, `followup_plan`, `review`, and `human_gate`. Nodes may specify `dependsOn` and JSON `input`. Dependencies gate readiness; worker completion requires the current fencing token.

| Route | Permission and behavior |
|---|---|
| `GET /v1/dags` and `GET /v1/dags/:id` | `dag.read`; list or inspect scoped runs and node/dependency state. |
| `POST /v1/dags` | `dag.write`; create a run with `{id?, nodes}`. |
| `POST /v1/dags/:id/pause` | `dag.write`; pause and mark running nodes interrupted. |
| `POST /v1/dags/:id/resume` | Human plus `dag.gate`; resume a paused run. Interrupted nodes still require explicit recovery. |
| `POST /v1/dags/:id/nodes/:node/claim` | `dag.worker`; claim a ready non-human node and receive its fencing token. |
| `POST /v1/dags/:id/nodes/:node/complete` | `dag.worker`; complete a claimed worker node using its current fencing token. |
| `POST /v1/dags/:id/nodes/:node/recover` | Human plus `dag.gate`; explicitly reset an interrupted node after its dependencies are complete. |
| `POST /v1/dags/:id/nodes/:node/gate` | Human plus `dag.gate`; pass or stop a ready human-gate node. |

A human gate does not approve or schedule a campaign and cannot send Gmail. No runtime LLM is configured. The UI creates preparatory plans and shows state; authorized worker integrations provide actual worker results.

## Durable store and operational boundaries

SQLite at `data/emar.sqlite` is default and requires Node.js 22.13+. One service process owns one file at a time. Set `EMAR_STORAGE=memory` for disposable fixtures. SQLite preserves templates, contacts/consent, suppression, snapshots, queue/idempotency, quota, tracking, audit, encrypted Gmail connections, and DAG runs. A crash with a persisted send in progress recovers to `SEND_UNKNOWN` without automatic resend.

Legacy `EMAILMAR_DAILY_LIMIT` and `EMAILMAR_PUBLIC_BASE_URL` remain accepted. `EMAR_STORAGE`, `EMAR_DATABASE_PATH`, and `EMAR_ADAPTER_MODULE` are the current names.

## Owner adapters and evidence boundary

- **CRM:** call `upsertRecipient`, `syncSuppression`, `recordReply`, and `recordHardBounce` with trusted scoped contexts. Only `EMAIL_MARKETING` + `GRANTED` is eligible.
- **Files:** call `registerAttachment` with a Files-owned reference and verified metadata. Inject `files.resolveBytes({fileRef, tenantId, businessId})`; Emar checks returned bytes against the approved SHA-256 and size.
- **Marketing:** pass exact approved template version and audience references into a draft. Emar snapshots execution inputs; it does not become the source of Marketing strategy.

Automated tests use fixture responses and never contact Gmail or send live email. A connected user account requires Google Cloud setup and explicit human consent. These local checks are not production-readiness, provider-delivery, tracking-reachability, reconciliation, deployment, or rollback evidence.

## Version diff

`0.2.0-beta.0` → `0.3.0-beta.0`: Emar branding, durable SQLite storage, Gmail OAuth connection and sender pinning, and persisted REST execution DAGs. Existing `emailmar` paths, scopes, and legacy adapter aliases remain.
