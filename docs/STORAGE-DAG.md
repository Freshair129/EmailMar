# Emar durable storage and execution DAG — 0.3.0-beta.0

## Store lifecycle

`SqliteStore` is the local durable implementation of the existing store interface. Construct it with an absolute database path and pass it to `EmarService` (the `EmailMarService` export remains available for compatibility):

```js
const store = new SqliteStore({ path: databasePath });
const service = new EmarService({ store, gmail });
// On orderly shutdown:
store.close();
```

The store retains the in-memory maps used by the service and also creates `connections` and `dagRuns`. Snapshots include every map and the audit array. SQLite schema `user_version` 2 is migrated transactionally; schema 1 raw DAG ids are rewritten to scope-qualified keys with an audit record, while a database with a newer schema fails closed. Snapshots are written in one SQLite transaction with full synchronous durability. The app uses one database owner at a time; a sidecar SQLite owner database holds an exclusive OS-backed transaction for the life of the store. A live second process receives `STORE_ALREADY_OPEN`. Process death releases the lock automatically.

Audited domain changes checkpoint the full coherent store snapshot before the operation returns. A worker checkpoints the queue claim, reserved-to-consumed quota transfer, message tracking tokens, and prepared-send audit before Gmail can be invoked. The Gmail adapter receives a synchronous `beforeRequest()` gate and the approved `expectedConnectionIdentity`; it must invoke the gate after token refresh and identity validation, immediately before the Gmail fetch, with no intervening await. The gate rechecks consent, suppression, address, campaign status and approval, queue state, and sender identity, then checkpoints again.

If snapshot serialization or a SQLite write fails, the operation fails and the store becomes poisoned. Later service reads and mutations return a storage error instead of exposing uncommitted in-memory state. The process must be restarted after correcting the storage failure.

## Recovery and quota behavior

On startup, every persisted queue item left in `sending` becomes terminal `SEND_UNKNOWN` with error `PROCESS_RESTARTED_DURING_SEND`. A recovery audit event and `delivery_unknown` signal are recorded. If that job's quota had only been reserved, recovery moves the reservation to consumed. If it was already consumed, it remains consumed. `SEND_UNKNOWN` is never selected by automatic dispatch; operator reconciliation with Gmail is required before any separate action.

Tracking tokens and the approved sender identity are part of the durable snapshot before Gmail invocation. An ambiguous provider outcome keeps its quota consumed. Errors explicitly marked safe before the Gmail request release quota. A changed or disconnected sender invalidates the approved snapshot hash, so scheduling requires a new approval after reconnection or account change. The worker reads the UTC day for each claim and checks it again immediately before Gmail fetch; a token refresh that crosses midnight cancels the preflight and releases the prior day's quota reservation instead of sending under a stale counter.

## Connection records

`store.connections` is included in each durable snapshot for the OAuth integration. Store only encrypted token envelopes there; never put access tokens, refresh tokens, client secrets, or credentials in the audit array or service projections. The OAuth adapter supplies `connectionIdentity({ tenantId, businessId })` synchronously as `{ connectionId, accountId, email }` or `null`. The approved snapshot pins these identity fields. Adapters without the getter remain supported for legacy fixtures.

## Execution DAG

`ExecutionDagService({ store, clock, idFactory })` persists scoped runs under a composite tenant/business/run-id key in `store.dagRuns`; its public run IDs remain unchanged. Its operations are:

| Operation | Permission | Purpose |
|---|---|---|
| `create(context, { id?, nodes })` | `dag.write` | Validate and persist an acyclic scoped run. |
| `get(context, runId)`, `list(context)` | `dag.read` | Read only runs in the caller's tenant/business scope. |
| `claim(context, runId, nodeId, { workerId? })` | `dag.worker` | Atomically claim a ready non-gate node and return its fencing token. |
| `complete(context, runId, nodeId, { fencingToken, result })` | `dag.worker` | Complete a running worker node only with its current token. |
| `complete(context, runId, gateId, { result: { decision } })` | human + `dag.gate` | Record a `pass` or `stop` decision for a ready human gate. |
| `pause(context, runId, reason)` | `dag.write` | Pause the run and interrupt/fence its active claims. |
| `resume(context, runId)` | human + `dag.gate` | Resume a paused run; interrupted work stays blocked. |
| `resumeInterrupted(context, runId, nodeId)` | human + `dag.gate` | Explicitly reset one interrupted node before it can be claimed again. |

Allowed kinds are `draft`, `subject`, `segmentation_suggestion`, `followup_plan`, `review`, and `human_gate`. Dependencies must exist and be acyclic. Independent ready nodes can be claimed concurrently; dependent nodes become ready only after every predecessor completes successfully. A `stop` gate decision stops the whole run and fences outstanding claims. Completed nodes cannot be changed. Read projections omit fencing tokens.

The DAG stores preparatory work only. A human gate is a generic workflow decision; it is not campaign approval. The DAG service does not invoke a model, approve a campaign, or send Gmail. Worker/model execution remains an explicit external integration concern.

## Version change

`0.2.0-beta.0` → `0.3.0-beta.0`: add transactional SQLite snapshots, exclusive single-process ownership, restart-safe send recovery, durable quota and tracking checkpoints, sender identity pinning, and scoped execution DAG persistence with fencing and human gates. Keep `EmailMarService` and existing module paths as compatibility exports.
