import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STORE_SCHEMA_VERSION = 2;
const MAP_NAMES = [
  'templates', 'attachments', 'recipients', 'suppressions', 'campaigns', 'queue',
  'scheduleKeys', 'dailyUsage', 'trackingTokens', 'recipientSignals', 'automations',
  'connections', 'dagRuns',
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function freezeLoadedState(store) {
  for (const value of store.templates.values()) deepFreeze(value);
  for (const value of store.attachments.values()) deepFreeze(value);
  for (const campaign of store.campaigns.values()) {
    if (campaign.approval) deepFreeze(campaign.approval);
    for (const approval of campaign.approvals ?? []) deepFreeze(approval);
  }
}

function mapSnapshot(map) {
  return [...map.entries()];
}

function acquireLock(ownerPath) {
  const database = new DatabaseSync(ownerPath);
  try {
    database.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE;');
    database.exec('CREATE TABLE IF NOT EXISTS emar_owner_guard (id INTEGER PRIMARY KEY CHECK (id = 1), nonce TEXT NOT NULL)');
    database.exec('BEGIN EXCLUSIVE');
    database.prepare(`
      INSERT INTO emar_owner_guard (id, nonce) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET nonce = excluded.nonce
    `).run(randomUUID());
    return database;
  } catch (error) {
    try { database.close(); } catch { /* failed lock acquisition */ }
    const lockError = new Error('The SQLite store is already open or its owner lock cannot be acquired.', { cause: error });
    lockError.code = error?.code?.includes('BUSY') || /locked|busy/i.test(error?.message ?? '') ? 'STORE_ALREADY_OPEN' : 'STORE_LOCK_UNAVAILABLE';
    lockError.status = lockError.code === 'STORE_ALREADY_OPEN' ? 409 : 503;
    throw lockError;
  }
}

function releaseLock(database) {
  if (!database) return;
  try { database.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
  try { database.close(); } catch { /* lock connection already closed */ }
}

function scopeKey(tenantId, businessId) {
  return JSON.stringify([tenantId, businessId]);
}

export class StorePersistenceError extends Error {
  constructor(message = 'Durable store operation failed.', cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StorePersistenceError';
    this.code = 'STORE_PERSISTENCE_FAILED';
    this.status = 503;
  }
}

export class InMemoryStore {
  constructor() {
    for (const name of MAP_NAMES) this[name] = new Map();
    this.audit = [];
    this.persistence = 'in_memory';
  }

  checkpoint() {}

  assertHealthy() {}

  close() {}
}

export class SqliteStore extends InMemoryStore {
  #ownerDatabase;
  #closed = false;
  #poisoned = false;

  constructor({ path } = {}) {
    if (typeof path !== 'string' || !path.trim()) throw new TypeError('SqliteStore requires a non-empty path.');
    super();
    this.path = resolve(path);
    this.persistence = 'sqlite';
    const ownerPath = `${this.path}.owner.sqlite`;
    mkdirSync(dirname(this.path), { recursive: true });
    this.#ownerDatabase = acquireLock(ownerPath);

    try {
      this.database = new DatabaseSync(this.path);
      this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
      this.#migrate();
      const snapshotSchemaVersion = this.#load();
      const migratedDagKeys = this.#normalizeDagRunKeys();
      freezeLoadedState(this);
      if (this.#recoverInterruptedWork() || migratedDagKeys || snapshotSchemaVersion < STORE_SCHEMA_VERSION) this.checkpoint();
    } catch (error) {
      try { this.database?.close(); } catch { /* constructor cleanup */ }
      releaseLock(this.#ownerDatabase);
      if (error instanceof StorePersistenceError || error?.code?.startsWith('STORE_')) throw error;
      throw new StorePersistenceError('Could not open or migrate the SQLite store.', error);
    }
  }

  #migrate() {
    const current = this.database.prepare('PRAGMA user_version').get().user_version;
    if (current > STORE_SCHEMA_VERSION) {
      const error = new Error(`Database schema ${current} is newer than supported schema ${STORE_SCHEMA_VERSION}.`);
      error.code = 'STORE_SCHEMA_TOO_NEW';
      error.status = 503;
      throw error;
    }
    this.database.exec('BEGIN EXCLUSIVE');
    try {
      if (current < 1) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS emar_store_snapshot (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            schema_version INTEGER NOT NULL,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          PRAGMA user_version = 1;
        `);
      }
      if (current < 2) this.database.exec('PRAGMA user_version = 2;');
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  #load() {
    const row = this.database.prepare('SELECT schema_version, payload FROM emar_store_snapshot WHERE id = 1').get();
    if (!row) return 0;
    if (row.schema_version > STORE_SCHEMA_VERSION) {
      const error = new Error(`Snapshot schema ${row.schema_version} is newer than supported schema ${STORE_SCHEMA_VERSION}.`);
      error.code = 'STORE_SCHEMA_TOO_NEW';
      error.status = 503;
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch (error) {
      throw new StorePersistenceError('The SQLite store snapshot is invalid JSON.', error);
    }
    for (const name of MAP_NAMES) {
      if (!Array.isArray(payload[name])) throw new StorePersistenceError(`The SQLite store snapshot is missing ${name}.`);
      this[name] = new Map(payload[name]);
    }
    if (!Array.isArray(payload.audit)) throw new StorePersistenceError('The SQLite store snapshot is missing audit history.');
    this.audit = payload.audit;
    return row.schema_version;
  }

  #normalizeDagRunKeys() {
    const normalized = new Map();
    const at = new Date().toISOString();
    let changed = false;
    for (const [storedKey, run] of this.dagRuns) {
      if (!run || typeof run.id !== 'string' || !run.id || typeof run.tenantId !== 'string' || !run.tenantId
        || typeof run.businessId !== 'string' || !run.businessId) {
        throw new StorePersistenceError('A persisted execution DAG run is missing its identity scope.');
      }
      const scopedId = JSON.stringify([run.tenantId, run.businessId, run.id]);
      if (normalized.has(scopedId)) throw new StorePersistenceError('Execution DAG run scope keys collide during migration.');
      if (storedKey !== scopedId) {
        changed = true;
        this.audit.push({
          id: randomUUID(), tenantId: run.tenantId, businessId: run.businessId,
          actorId: 'emar-storage-migration', action: 'dag.run_scope_key_migrated',
          subjectType: 'dag_run', subjectId: String(run.id).slice(0, 160), at,
          details: { fromSchema: 1, toSchema: STORE_SCHEMA_VERSION },
        });
      }
      normalized.set(scopedId, run);
    }
    this.dagRuns = normalized;
    return changed;
  }

  #recoverInterruptedWork() {
    const abandoned = [...this.queue.values()].filter((job) => job.status === 'sending');
    let recovered = false;
    const at = new Date().toISOString();
    for (const job of abandoned) {
      recovered = true;
      let usage = this.dailyUsage.get(job.day);
      if (!usage) {
        usage = { reserved: 0, consumed: 0 };
        this.dailyUsage.set(job.day, usage);
      }
      if (job.quotaConsumed !== true) {
        usage.reserved = Math.max(0, usage.reserved - 1);
        usage.consumed += 1;
      }
      job.quotaConsumed = true;
      job.status = 'SEND_UNKNOWN';
      job.errorCode = 'PROCESS_RESTARTED_DURING_SEND';
      job.completedAt = at;

      const signal = { type: 'delivery_unknown', recipientId: job.recipientId, at, campaignId: job.campaignId, queueId: job.id };
      const key = `${scopeKey(job.tenantId, job.businessId)}:${job.recipientId}`;
      const history = this.recipientSignals.get(key) ?? [];
      history.push(signal);
      this.recipientSignals.set(key, history);
      const campaign = this.campaigns.get(job.campaignId);
      if (campaign?.tenantId === job.tenantId && campaign?.businessId === job.businessId) campaign.signals.push(signal);
      this.audit.push({
        id: randomUUID(), tenantId: job.tenantId, businessId: job.businessId,
        actorId: 'emar-storage-recovery', action: 'queue.recovery_send_unknown',
        subjectType: 'queue_entry', subjectId: String(job.id).slice(0, 160), at,
        details: { reason: job.errorCode, quotaPreserved: true },
      });
    }
    for (const run of this.dagRuns.values()) {
      for (const node of run.nodes ?? []) {
        if (node.state !== 'running') continue;
        recovered = true;
        node.state = 'interrupted';
        node.claimToken = null;
        node.interruptedAt = at;
        node.updatedAt = at;
        this.audit.push({
          id: randomUUID(), tenantId: run.tenantId, businessId: run.businessId,
          actorId: 'emar-storage-recovery', action: 'dag.node_interrupted',
          subjectType: 'dag_node', subjectId: String(node.id).slice(0, 160), at,
          details: { runId: run.id, reason: 'PROCESS_RESTARTED_WITH_ACTIVE_CLAIM' },
        });
      }
      if (run.nodes?.some((node) => node.state === 'interrupted')) run.updatedAt = at;
    }
    return recovered;
  }

  checkpoint() {
    if (this.#closed) throw new StorePersistenceError('The SQLite store is closed.');
    if (this.#poisoned) throw new StorePersistenceError('The SQLite store is unavailable after a prior checkpoint failure.');
    try {
      const payload = JSON.stringify({ ...Object.fromEntries(MAP_NAMES.map((name) => [name, mapSnapshot(this[name])])), audit: this.audit });
      this.database.exec('BEGIN IMMEDIATE');
      this.database.prepare(`
        INSERT INTO emar_store_snapshot (id, schema_version, payload, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, payload = excluded.payload, updated_at = excluded.updated_at
      `).run(STORE_SCHEMA_VERSION, payload, new Date().toISOString());
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      this.#poisoned = true;
      throw new StorePersistenceError('Could not atomically checkpoint the SQLite store.', error);
    }
  }

  assertHealthy() {
    if (this.#closed) throw new StorePersistenceError('The SQLite store is closed.');
    if (this.#poisoned) throw new StorePersistenceError('The SQLite store is unavailable after a prior checkpoint failure.');
  }

  close() {
    if (this.#closed) return;
    let checkpointError;
    try { this.checkpoint(); } catch (error) { checkpointError = error; }
    try { this.database.close(); } finally {
      releaseLock(this.#ownerDatabase);
      this.#ownerDatabase = null;
      this.#closed = true;
    }
    if (checkpointError) throw checkpointError;
  }
}
