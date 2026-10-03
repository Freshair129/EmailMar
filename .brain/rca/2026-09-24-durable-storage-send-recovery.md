# Durable storage and send recovery — 2026-09-24

## Symptom

Campaigns, quota, tracking tokens, and audit history previously existed only in process-local maps. A restart discarded those records, and a worker interrupted while a queue item was `sending` had no durable state to prevent a repeated send.

## Evidence

The service defaulted to `InMemoryStore`; the queue claim and quota changes were Map/object mutations. The prior test coverage verified same-process worker behavior but did not reopen a database or kill a process while it held the store.

## Root Cause

There was no durable transaction boundary for service mutations, queue claims, quota accounting, or provider tracking tokens. The worker's synchronous in-process claim prevented overlap only while that Node process remained alive.

## Why the issue escaped detection

Existing service and HTTP fixtures constructed the default in-memory store. They could not detect state loss, recovery behavior, or lock races between independent processes.

## Proposed prevention

Use atomic SQLite snapshot transactions, a lifetime sidecar SQLite exclusive transaction for single-process ownership, checkpoint every audited mutation and prepared send, and poison the store after any persistence failure. Scope DAG map keys by tenant, business, and run id; schema 2 migrates schema 1 raw run ids and writes an audit record. On startup, convert abandoned `sending` jobs into audited `SEND_UNKNOWN`, preserve their quota conservatively, and never automatically retry them. Verify restart recovery, failed writes, pre-request consent changes, scoped DAG isolation, and competing subprocess ownership with `node:test`.
