import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { EmailMarService, EmarService } from '../src/domain/emailmar-service.mjs';
import { SqliteStore } from '../src/domain/store.mjs';

const HUMAN = {
  tenantId: 'tenant-a', businessId: 'business-a', actorId: 'operator-a', actorType: 'human', permissions: ['*'],
};
const NOW = '2026-09-24T10:00:00.000Z';

function fixturePath() {
  const directory = mkdtempSync(join(tmpdir(), 'emar-storage-'));
  return { directory, path: join(directory, 'state.sqlite') };
}

function seedCampaign(service, prefix = 'fixture') {
  service.createTemplate(HUMAN, {
    id: `${prefix}-template`, version: 1, subject: 'Hello {{name}}', html: '<p>Hello {{name}}</p>',
    plainText: 'Hello {{name}}', variables: ['name'],
  });
  service.upsertRecipient(HUMAN, {
    id: `${prefix}-recipient`, displayName: 'Fixture recipient', email: `${prefix}@example.test`,
    consents: [{ type: 'EMAIL_MARKETING', status: 'GRANTED' }],
  });
  return service.createCampaignDraft(HUMAN, {
    name: `${prefix} campaign`, templateId: `${prefix}-template`, templateVersion: 1,
    recipientIds: [`${prefix}-recipient`], recipientVariables: { [`${prefix}-recipient`]: { name: 'Fixture' } }, attachmentIds: [],
  });
}

function createService(path, options = {}) {
  return new EmailMarService({
    store: new SqliteStore({ path }),
    clock: () => new Date(NOW),
    ...options,
  });
}

function startStoreHolder(path) {
  const storeModule = new URL('../src/domain/store.mjs', import.meta.url).href;
  const source = `
    import { SqliteStore } from ${JSON.stringify(storeModule)};
    try {
      const store = new SqliteStore({ path: ${JSON.stringify(path)} });
      process.send({ status: 'acquired' });
      setInterval(() => {}, 1000);
    } catch (error) {
      process.send({ status: 'denied', code: error.code });
      process.send(null, () => process.exit(0));
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const message = new Promise((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => rejectMessage(new Error(`SQLite contender timed out. ${stderr}`)), 8000);
    child.once('message', (value) => { clearTimeout(timer); resolveMessage(value); });
    child.once('error', (error) => { clearTimeout(timer); rejectMessage(error); });
    child.once('exit', (code) => {
      if (code !== null) {
        clearTimeout(timer);
        rejectMessage(new Error(`SQLite contender exited before reporting. code=${code} ${stderr}`));
      }
    });
  });
  return { child, message };
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('SQLite snapshots survive restart, preserve scope, and freeze immutable content', () => {
  const fixture = fixturePath();
  let service;
  try {
    service = createService(fixture.path);
    const campaign = seedCampaign(service);
    service.registerAttachment(HUMAN, {
      id: 'fixture-attachment', fileRef: 'files:fixture', sha256: 'a'.repeat(64),
      filename: 'fixture.txt', mimeType: 'text/plain', size: 0, version: 1,
    });
    service.updateCampaignDraft(HUMAN, campaign.id, { attachmentIds: ['fixture-attachment'] });
    service.approveCampaign(HUMAN, campaign.id);
    const scheduled = service.scheduleCampaign(HUMAN, campaign.id);
    service.store.connections.set('tenant-a:business-a', { refreshTokenCiphertext: 'sealed-fixture-value' });
    service.store.checkpoint();
    service.store.close();

    service = createService(fixture.path);
    assert.equal(service.getHealth().service, 'emar');
    assert.equal(service.getHealth().version, '0.3.0-beta.0');
    assert.equal(service.getHealth().persistence, 'sqlite');
    assert.equal(service.getCampaign(HUMAN, campaign.id).status, 'scheduled');
    assert.deepEqual(service.scheduleCampaign(HUMAN, campaign.id).queueIds, scheduled.queueIds);
    assert.equal(service.store.queue.size, 1);
    assert.deepEqual(service.store.connections.get('tenant-a:business-a'), { refreshTokenCiphertext: 'sealed-fixture-value' });
    assert.ok(Object.isFrozen(service.store.templates.get('["tenant-a","business-a"]:fixture-template@1')));
    assert.ok(Object.isFrozen(service.store.attachments.get('["tenant-a","business-a"]:fixture-attachment')));
    const persistedCampaign = service.store.campaigns.get(campaign.id);
    assert.ok(Object.isFrozen(persistedCampaign.approval));
    assert.ok(Object.isFrozen(persistedCampaign.approval.snapshot));
    assert.ok(Object.isFrozen(persistedCampaign.approval.snapshot.attachments[0]));
    assert.throws(() => service.getCampaign({ ...HUMAN, businessId: 'other-business' }, campaign.id), { code: 'NOT_FOUND' });
  } finally {
    try { service?.store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('an ambiguous Gmail outcome stays SEND_UNKNOWN with consumed quota and tracking tokens after restart', async () => {
  const fixture = fixturePath();
  let calls = 0;
  let service;
  const gmail = {
    send: async () => {
      calls += 1;
      const error = new Error('socket timeout after request invocation');
      error.code = 'GMAIL_SEND_UNKNOWN';
      error.requestStarted = true;
      throw error;
    },
  };
  try {
    service = createService(fixture.path, { gmail });
    const campaign = seedCampaign(service, 'ambiguous');
    service.approveCampaign(HUMAN, campaign.id);
    service.scheduleCampaign(HUMAN, campaign.id);
    const result = await service.dispatchDue(HUMAN, { campaignId: campaign.id });
    assert.equal(result.outcomes[0].status, 'SEND_UNKNOWN');
    assert.equal(service.store.dailyUsage.get('2026-09-24').consumed, 1);
    assert.equal(service.store.trackingTokens.size, 2);
    service.store.close();

    service = createService(fixture.path, { gmail });
    assert.equal(service.store.queue.values().next().value.status, 'SEND_UNKNOWN');
    assert.equal(service.store.dailyUsage.get('2026-09-24').consumed, 1);
    assert.equal(service.store.trackingTokens.size, 2);
    assert.equal((await service.dispatchDue(HUMAN, { campaignId: campaign.id })).considered, 0);
    assert.equal(calls, 1);
  } finally {
    try { service?.store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('restart recovers an abandoned sending claim to SEND_UNKNOWN and consumes its reservation once', () => {
  const fixture = fixturePath();
  let service;
  try {
    service = createService(fixture.path);
    const campaign = seedCampaign(service, 'recovery');
    service.approveCampaign(HUMAN, campaign.id);
    service.scheduleCampaign(HUMAN, campaign.id);
    const job = service.store.queue.values().next().value;
    job.status = 'sending';
    job.startedAt = NOW;
    job.quotaConsumed = false;
    service.store.checkpoint();
    service.store.close();

    service = createService(fixture.path);
    const recovered = service.store.queue.values().next().value;
    assert.equal(recovered.status, 'SEND_UNKNOWN');
    assert.equal(recovered.errorCode, 'PROCESS_RESTARTED_DURING_SEND');
    assert.equal(recovered.quotaConsumed, true);
    assert.deepEqual(service.store.dailyUsage.get('2026-09-24'), { reserved: 0, consumed: 1 });
    assert.ok(service.store.audit.some((event) => event.action === 'queue.recovery_send_unknown'));
  } finally {
    try { service?.store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('failed durable checkpoint blocks Gmail invocation and poisons later service reads', async () => {
  const fixture = fixturePath();
  let calls = 0;
  let service;
  try {
    service = createService(fixture.path, { gmail: { send: async () => { calls += 1; return { accepted: true }; } } });
    const campaign = seedCampaign(service, 'write-failure');
    service.approveCampaign(HUMAN, campaign.id);
    service.scheduleCampaign(HUMAN, campaign.id);
    service.store.database.exec('PRAGMA query_only = ON');
    await assert.rejects(service.dispatchDue(HUMAN, { campaignId: campaign.id }), { code: 'STORE_PERSISTENCE_FAILED' });
    assert.equal(calls, 0);
    assert.throws(() => service.getCampaignReport(HUMAN, campaign.id), { code: 'STORE_PERSISTENCE_FAILED' });
  } finally {
    try { service?.store.close(); } catch { /* query_only intentionally blocks the final checkpoint */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a consent change during token refresh is blocked synchronously before Gmail request', async () => {
  const fixture = fixturePath();
  let sends = 0;
  let releaseRefresh;
  let enteredRefresh;
  const refresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const entered = new Promise((resolve) => { enteredRefresh = resolve; });
  let service;
  try {
    const gmail = {
      send: async ({ beforeRequest }) => {
        enteredRefresh();
        await refresh;
        beforeRequest();
        sends += 1;
        return { accepted: true };
      },
    };
    service = createService(fixture.path, { gmail });
    const campaign = seedCampaign(service, 'consent-race');
    service.approveCampaign(HUMAN, campaign.id);
    service.scheduleCampaign(HUMAN, campaign.id);
    const dispatch = service.dispatchDue(HUMAN, { campaignId: campaign.id });
    await entered;
    service.upsertRecipient(HUMAN, {
      id: 'consent-race-recipient', displayName: 'Fixture recipient', email: 'consent-race@example.test', consents: [],
    });
    releaseRefresh();
    const result = await dispatch;
    assert.equal(sends, 0);
    assert.equal(result.outcomes[0].status, 'cancelled');
    assert.equal(service.store.dailyUsage.get('2026-09-24').consumed, 0);
    service.store.close();

    service = createService(fixture.path);
    assert.equal(service.store.queue.values().next().value.status, 'cancelled');
    assert.equal(service.store.dailyUsage.get('2026-09-24').consumed, 0);
  } finally {
    releaseRefresh?.();
    try { service?.store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Gmail sender identity is pinned through token refresh and offline approvals need reapproval', async () => {
  const fixture = fixturePath();
  const identityA = { connectionId: 'conn-a', accountId: 'account-a', email: 'sender-a@example.test' };
  const identityB = { connectionId: 'conn-b', accountId: 'account-b', email: 'sender-b@example.test' };
  let identity = identityA;
  let releaseRefresh;
  let enteredRefresh;
  let expectedIdentity;
  let fetches = 0;
  const refresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const entered = new Promise((resolve) => { enteredRefresh = resolve; });
  let service;
  try {
    const gmail = {
      connectionIdentity: () => identity,
      send: async (options) => {
        expectedIdentity = options.expectedConnectionIdentity;
        enteredRefresh();
        await refresh;
        identity = identityB;
        options.beforeRequest();
        fetches += 1;
        return { accepted: true };
      },
    };
    service = createService(fixture.path, { gmail });
    const campaign = seedCampaign(service, 'sender-pin');
    service.approveCampaign(HUMAN, campaign.id);
    service.scheduleCampaign(HUMAN, campaign.id);
    const dispatch = service.dispatchDue(HUMAN, { campaignId: campaign.id });
    await entered;
    releaseRefresh();
    const result = await dispatch;
    assert.deepEqual(expectedIdentity, identityA);
    assert.equal(fetches, 0);
    assert.equal(result.outcomes[0].status, 'cancelled');
    assert.equal(result.outcomes[0].reason, 'GMAIL_SENDER_CHANGED_OR_DISCONNECTED');
    assert.equal(service.store.dailyUsage.get('2026-09-24').consumed, 0);
    service.store.close();

    let offlineIdentity = null;
    const offlineService = createService(fixture.path, { gmail: { connectionIdentity: () => offlineIdentity, send: async () => ({ accepted: true }) } });
    const offlineCampaign = seedCampaign(offlineService, 'offline-sender');
    offlineService.approveCampaign(HUMAN, offlineCampaign.id);
    offlineIdentity = identityA;
    assert.throws(() => offlineService.scheduleCampaign(HUMAN, offlineCampaign.id), { code: 'REAPPROVAL_REQUIRED' });
    offlineService.store.close();
    service = null;
  } finally {
    releaseRefresh?.();
    try { service?.store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('authentication refresh failure before Gmail releases the quota reservation', async () => {
  const fixture = fixturePath();
  let service;
  try {
    service = createService(fixture.path, {
      gmail: {
        send: async () => {
          const error = new Error('fixture authorization unavailable before request');
          error.code = 'GMAIL_AUTH_REFRESH_FAILED';
          error.safeToRetry = true;
          error.requestStarted = false;
          throw error;
        },
      },
    });
    const campaign = seedCampaign(service, 'auth-refresh');
    service.approveCampaign(HUMAN, campaign.id);
    service.scheduleCampaign(HUMAN, campaign.id);
    const result = await service.dispatchDue(HUMAN, { campaignId: campaign.id });
    assert.equal(result.outcomes[0].status, 'not_sent');
    assert.equal(service.store.dailyUsage.get('2026-09-24').consumed, 0);
    assert.equal(service.store.dailyUsage.get('2026-09-24').reserved, 0);
  } finally {
    try { service?.store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a token refresh that crosses UTC midnight cannot send against the prior day quota', async () => {
  const fixture = fixturePath();
  let time = Date.parse('2026-09-24T23:59:59.900Z');
  let releaseRefresh;
  let enteredRefresh;
  let fetches = 0;
  const refresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const entered = new Promise((resolve) => { enteredRefresh = resolve; });
  let service;
  try {
    const store = new SqliteStore({ path: fixture.path });
    service = new EmailMarService({
      store,
      clock: () => new Date(time),
      gmail: {
        send: async ({ beforeRequest }) => {
          enteredRefresh();
          await refresh;
          beforeRequest();
          fetches += 1;
          return { accepted: true };
        },
      },
    });
    const campaign = seedCampaign(service, 'midnight-boundary');
    service.approveCampaign(HUMAN, campaign.id);
    service.scheduleCampaign(HUMAN, campaign.id);
    const dispatch = service.dispatchDue(HUMAN, { campaignId: campaign.id });
    await entered;
    time = Date.parse('2026-09-25T00:00:00.100Z');
    releaseRefresh();
    const result = await dispatch;
    assert.equal(fetches, 0);
    assert.equal(result.outcomes[0].status, 'cancelled');
    assert.equal(result.outcomes[0].reason, 'DAILY_LIMIT_DAY_CHANGED');
    assert.equal(service.store.dailyUsage.get('2026-09-24').consumed, 0);
    assert.equal(service.store.dailyUsage.has('2026-09-25'), false);
  } finally {
    releaseRefresh?.();
    try { service?.store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('SQLite exclusive sidecar survives abrupt owner exit and rejects a competing process', async () => {
  const fixture = fixturePath();
  const children = [];
  try {
    const initial = startStoreHolder(fixture.path);
    children.push(initial.child);
    assert.deepEqual(await initial.message, { status: 'acquired' });
    await killChild(initial.child);

    const contenders = [startStoreHolder(fixture.path), startStoreHolder(fixture.path)];
    children.push(...contenders.map((entry) => entry.child));
    const messages = await Promise.all(contenders.map((entry) => entry.message));
    assert.equal(messages.filter((message) => message.status === 'acquired').length, 1);
    assert.equal(messages.filter((message) => message.status === 'denied').length, 1);
    const denial = messages.find((message) => message.status === 'denied');
    assert.equal(denial.code, 'STORE_ALREADY_OPEN');
    for (let index = 0; index < contenders.length; index += 1) {
      if (messages[index].status === 'acquired') await killChild(contenders[index].child);
    }

    const recovered = startStoreHolder(fixture.path);
    children.push(recovered.child);
    assert.deepEqual(await recovered.message, { status: 'acquired' });
    await killChild(recovered.child);
  } finally {
    for (const child of children) {
      try { await killChild(child); } catch { /* process may already have exited */ }
    }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('legacy compatibility exports EmarService and sqlite lock releases on close', () => {
  const fixture = fixturePath();
  let store;
  try {
    assert.equal(EmarService, EmailMarService);
    store = new SqliteStore({ path: fixture.path });
    assert.equal(store.persistence, 'sqlite');
    assert.throws(() => new SqliteStore({ path: fixture.path }), { code: 'STORE_ALREADY_OPEN' });
    store.close();
    store = new SqliteStore({ path: fixture.path });
    assert.equal(store.persistence, 'sqlite');
  } finally {
    try { store?.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a schema newer than the runtime fails closed and releases the owner lock', () => {
  const fixture = fixturePath();
  let database;
  try {
    database = new DatabaseSync(fixture.path);
    database.exec('PRAGMA user_version = 99');
    database.close();
    database = null;
    assert.throws(() => new SqliteStore({ path: fixture.path }), { code: 'STORE_SCHEMA_TOO_NEW' });
    assert.throws(() => new SqliteStore({ path: fixture.path }), { code: 'STORE_SCHEMA_TOO_NEW' });
  } finally {
    try { database?.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a failed snapshot serialization preserves the last committed snapshot', () => {
  const fixture = fixturePath();
  let store;
  try {
    store = new SqliteStore({ path: fixture.path });
    store.connections.set('fixture-scope', { encryptedTokens: 'sealed-fixture-envelope' });
    store.checkpoint();
    const circular = {};
    circular.self = circular;
    store.connections.set('invalid-fixture-scope', circular);
    assert.throws(() => store.checkpoint(), { code: 'STORE_PERSISTENCE_FAILED' });
    try { store.close(); } catch { /* the failed checkpoint poisons the store */ }

    store = new SqliteStore({ path: fixture.path });
    assert.deepEqual(store.connections.get('fixture-scope'), { encryptedTokens: 'sealed-fixture-envelope' });
    assert.equal(store.connections.has('invalid-fixture-scope'), false);
  } finally {
    try { store?.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('schema 1 raw DAG ids migrate to scope-qualified keys with an audit record', () => {
  const fixture = fixturePath();
  let store;
  let database;
  try {
    store = new SqliteStore({ path: fixture.path });
    store.close();
    store = null;
    database = new DatabaseSync(fixture.path);
    const row = database.prepare('SELECT payload FROM emar_store_snapshot WHERE id = 1').get();
    const payload = JSON.parse(row.payload);
    payload.dagRuns = [['legacy-run', {
      id: 'legacy-run', tenantId: 'tenant-a', businessId: 'business-a', createdBy: 'fixture',
      status: 'active', pauseReason: null, createdAt: NOW, updatedAt: NOW, nodes: [],
    }]];
    database.prepare('UPDATE emar_store_snapshot SET schema_version = 1, payload = ? WHERE id = 1').run(JSON.stringify(payload));
    database.exec('PRAGMA user_version = 1');
    database.close();
    database = null;

    store = new SqliteStore({ path: fixture.path });
    const scopedKey = JSON.stringify(['tenant-a', 'business-a', 'legacy-run']);
    assert.ok(store.dagRuns.has(scopedKey));
    assert.equal(store.dagRuns.has('legacy-run'), false);
    assert.ok(store.audit.some((event) => event.action === 'dag.run_scope_key_migrated'));
    assert.equal(store.database.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(store.database.prepare('SELECT schema_version FROM emar_store_snapshot WHERE id = 1').get().schema_version, 2);
  } finally {
    try { store?.close(); } catch { /* keep fixture cleanup deterministic */ }
    try { database?.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
