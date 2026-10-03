import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createEmailMarServer } from '../src/http/server.mjs';
import { EmailMarService } from '../src/domain/emailmar-service.mjs';
import { InMemoryStore } from '../src/domain/store.mjs';
import { ExecutionDagService } from '../src/domain/execution-dag.mjs';
import { createGmailApiAdapter } from '../src/adapters/gmail-api.mjs';

async function unusedPort() {
  const probe = createHttpServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function withApp({ service, store = new InMemoryStore(), executionDag, gmailConnectionsFactory, authorizeRequest, standalone = true } = {}, action) {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const gmailRedirectUri = `${origin}/v1/integrations/gmail/callback`;
  const gmailConnections = gmailConnectionsFactory?.(origin);
  const appService = service ?? new EmailMarService({ store });
  const dagService = executionDag ?? new ExecutionDagService({ store });
  const server = createEmailMarServer({ service: appService, authorizeRequest, standalone, gmailConnections, gmailRedirectUri, executionDag: dagService });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  try { return await action({ origin, server, service: appService, store, gmailConnections, executionDag: dagService, gmailRedirectUri }); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function openSession(origin) {
  const response = await fetch(`${origin}/ui/session`, {
    method: 'POST',
    headers: { origin, 'x-emailmar-client': 'standalone-ui' },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  return { cookie: setCookie.split(';', 1)[0], csrfToken: body.csrfToken };
}

function browserRequest(origin, session, path, { method = 'GET', body, csrf = true, requestOrigin = origin, extraHeaders = {} } = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(requestOrigin ? { origin: requestOrigin } : {}),
      ...(session?.cookie ? { cookie: session.cookie } : {}),
      ...(method !== 'GET' && csrf && session?.csrfToken ? { 'x-csrf-token': session.csrfToken } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test('DAG stylesheet is served publicly with a CSS content type', async () => {
  await withApp({}, async ({ origin }) => {
    const response = await fetch(`${origin}/ui/dags.css`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/css/);
    assert.match(await response.text(), /\.dag-node/);
  });
});

test('Gmail OAuth start requires CSRF, uses the configured origin, and callback needs only the bound Lax cookie', async () => {
  let startedBinding;
  await withApp({
    gmailConnectionsFactory: (origin) => ({
      callbackOrigin: origin,
      start: async (_context, { sessionBinding }) => {
        assert.equal(sessionBinding.length, 64);
        return { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=server-owned' };
      },
      status: () => ({ status: 'DISCONNECTED' }),
      complete: async (input) => {
        assert.deepEqual(input, { state: 'fixture-state', code: 'fixture-code', error: null, sessionBinding: startedBinding });
        return { status: 'CONNECTED', email: 'owner@example.com' };
      },
      disconnect: () => ({ status: 'DISCONNECTED' }),
    }),
  }, async ({ origin, gmailConnections }) => {
    const originalStart = gmailConnections.start;
    gmailConnections.start = async (...args) => {
      const result = await originalStart(...args);
      startedBinding = args[1].sessionBinding;
      return result;
    };
    const session = await openSession(origin);
    const csrfDenied = await browserRequest(origin, session, '/v1/integrations/gmail/connect', { method: 'POST', body: {}, csrf: false });
    assert.equal(csrfDenied.status, 403);

    const wrongOrigin = await browserRequest(origin, session, '/v1/integrations/gmail/connect', { method: 'POST', body: {}, requestOrigin: 'http://localhost:8788' });
    assert.equal(wrongOrigin.status, 403);

    const status = await browserRequest(origin, session, '/v1/integrations/gmail/status');
    assert.deepEqual(await status.json(), { status: 'DISCONNECTED', redirectUri: `${origin}/v1/integrations/gmail/callback` });

    const start = await browserRequest(origin, session, '/v1/integrations/gmail/connect', { method: 'POST', body: {} });
    assert.equal(start.status, 200);
    assert.equal((await start.json()).authorizationUrl.startsWith('https://accounts.google.com/'), true);
    const callbackCookie = start.headers.getSetCookie?.()[0] ?? start.headers.get('set-cookie');
    assert.match(callbackCookie, /HttpOnly/);
    assert.match(callbackCookie, /SameSite=Lax/);
    assert.match(callbackCookie, /Path=\/v1\/integrations\/gmail\/callback/);
    assert.match(callbackCookie, /Max-Age=600/);
    const binding = callbackCookie.match(/emar_gmail_oauth=([^;]+)/)?.[1];
    assert.equal(binding, startedBinding);

    const callback = await fetch(`${origin}/v1/integrations/gmail/callback?state=fixture-state&code=fixture-code`, {
      headers: { cookie: `emar_gmail_oauth=${binding}`, 'sec-fetch-site': 'cross-site' },
      redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    const location = callback.headers.get('location');
    assert.equal(location, '/#settings/callback-connected');
    assert.equal(location.includes('fixture-state'), false);
    assert.equal(location.includes('fixture-code'), false);
    const cleared = callback.headers.getSetCookie?.()[0] ?? callback.headers.get('set-cookie');
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /Path=\/v1\/integrations\/gmail\/callback/);
  });
});

test('Gmail callback maps provider denial to a fixed marker and never reflects provider text', async () => {
  await withApp({
    gmailConnectionsFactory: (origin) => ({
      callbackOrigin: origin,
      complete: async ({ error }) => {
        assert.equal(error, 'access_denied');
        return { status: 'CONNECTED', email: 'existing@example.com', outcome: 'CANCELLED' };
      },
      status: () => ({ status: 'DISCONNECTED' }),
    }),
  }, async ({ origin }) => {
    const response = await fetch(`${origin}/v1/integrations/gmail/callback?state=opaque&error=access_denied`, {
      headers: { cookie: 'emar_gmail_oauth=fixture-binding', 'sec-fetch-site': 'cross-site' },
      redirect: 'manual',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/#settings/callback-cancelled');
    assert.equal(response.headers.get('location').includes('access_denied'), false);
  });
});

test('disconnected Gmail is refused before campaign dispatch mutates the queue', async () => {
  let dispatchCalls = 0;
  let queueMutations = 0;
  const service = {
    gmail: { connectionIdentity: () => null },
    getHealth: () => ({ status: 'ok' }),
    dispatchCampaign: async () => { dispatchCalls += 1; queueMutations += 1; return {}; },
  };
  await withApp({
    service,
    gmailConnectionsFactory: () => ({ status: () => ({ status: 'DISCONNECTED' }) }),
  }, async ({ origin }) => {
    const session = await openSession(origin);
    const response = await browserRequest(origin, session, '/v1/campaigns/campaign-1/dispatch', { method: 'POST', body: {} });
    const result = await response.json();
    assert.equal(response.status, 503);
    assert.equal(result.error.code, 'GMAIL_NOT_CONNECTED');
    assert.equal(dispatchCalls, 0);
    assert.equal(queueMutations, 0);
  });
});

test('DAG REST routes expose scoped creation, fencing, gates, pause, resume, and explicit recovery', async () => {
  await withApp({}, async ({ origin }) => {
    const session = await openSession(origin);
    const created = await browserRequest(origin, session, '/v1/dags', {
      method: 'POST', body: { id: 'fixture-run', nodes: [
        { id: 'draft', kind: 'draft' },
        { id: 'gate', kind: 'human_gate', dependsOn: ['draft'] },
      ] },
    });
    assert.equal(created.status, 201);
    const initial = await created.json();
    assert.equal(initial.nodes[0].state, 'ready');
    assert.equal(initial.nodes[1].state, 'blocked');

    const claimResponse = await browserRequest(origin, session, '/v1/dags/fixture-run/nodes/draft/claim', { method: 'POST', body: { workerId: 'fixture-worker' } });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.node.state, 'running');
    assert.equal(typeof claim.fencingToken, 'string');

    const complete = await browserRequest(origin, session, '/v1/dags/fixture-run/nodes/draft/complete', { method: 'POST', body: { fencingToken: claim.fencingToken, result: { fixture: true } } });
    assert.equal(complete.status, 200);
    assert.equal((await complete.json()).nodes[1].state, 'ready');
    const gate = await browserRequest(origin, session, '/v1/dags/fixture-run/nodes/gate/gate', { method: 'POST', body: { decision: 'pass' } });
    assert.equal(gate.status, 200);
    assert.equal((await gate.json()).status, 'completed');

    const recoveryCreate = await browserRequest(origin, session, '/v1/dags', { method: 'POST', body: { id: 'recovery-run', nodes: [{ id: 'one', kind: 'draft' }] } });
    assert.equal(recoveryCreate.status, 201);
    const claimTwo = await browserRequest(origin, session, '/v1/dags/recovery-run/nodes/one/claim', { method: 'POST', body: { workerId: 'fixture-worker' } });
    assert.equal(claimTwo.status, 200);
    const paused = await browserRequest(origin, session, '/v1/dags/recovery-run/pause', { method: 'POST', body: { reason: 'fixture interruption' } });
    assert.equal((await paused.json()).status, 'paused');
    const resumed = await browserRequest(origin, session, '/v1/dags/recovery-run/resume', { method: 'POST', body: {} });
    assert.equal((await resumed.json()).status, 'active');
    const recovered = await browserRequest(origin, session, '/v1/dags/recovery-run/nodes/one/recover', { method: 'POST', body: {} });
    assert.equal((await recovered.json()).nodes[0].state, 'ready');
    const listed = await browserRequest(origin, session, '/v1/dags');
    assert.equal((await listed.json()).length, 2);
  });
});

test('DAG list requires its dedicated permission in integrated mode', async () => {
  const context = { tenantId: 'tenant-a', businessId: 'business-a', actorId: 'agent-a', actorType: 'agent', permissions: ['campaign.read'] };
  await withApp({ standalone: false, authorizeRequest: async () => context }, async ({ origin }) => {
    const response = await fetch(`${origin}/v1/dags`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'FORBIDDEN');
  });
});

function racingService(afterToken) {
  const identity = { connectionId: 'connection-a', accountId: 'google-subject-a', email: 'sender@example.com' };
  let fetchCount = 0;
  let service;
  const gmail = createGmailApiAdapter({
    getAccessToken: async ({ expectedConnectionIdentity }) => {
      assert.deepEqual(expectedConnectionIdentity, identity);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await afterToken(service);
      return 'fixture-access-token';
    },
    connectionIdentity: () => identity,
    fetchImpl: async (_url, request) => {
      fetchCount += 1;
      const mime = Buffer.from(JSON.parse(request.body).raw, 'base64url').toString('utf8');
      assert.match(mime, /From: sender@example\.com/);
      return { ok: true, status: 200, json: async () => ({ id: 'fixture-message-id' }) };
    },
  });
  const now = new Date('2026-09-24T10:00:00.000Z');
  service = new EmailMarService({ store: new InMemoryStore(), gmail, clock: () => new Date(now) });
  service.createTemplate({ tenantId: 'tenant-a', businessId: 'business-a', actorId: 'human-a', actorType: 'human', permissions: ['*'] }, {
    id: 'welcome', version: 1, subject: 'Hello', html: '<p>Hello</p>', plainText: 'Hello', variables: [],
  });
  service.upsertRecipient({ tenantId: 'tenant-a', businessId: 'business-a', actorId: 'human-a', actorType: 'human', permissions: ['*'] }, {
    id: 'contact-1', email: 'recipient@example.com', consents: [{ type: 'EMAIL_MARKETING', status: 'GRANTED' }],
  });
  const context = { tenantId: 'tenant-a', businessId: 'business-a', actorId: 'human-a', actorType: 'human', permissions: ['*'] };
  const campaign = service.createCampaignDraft(context, { name: 'Welcome', templateId: 'welcome', templateVersion: 1, recipientIds: ['contact-1'] });
  service.approveCampaign(context, campaign.id);
  service.scheduleCampaign(context, campaign.id);
  return { service, context, campaign, fetchCount: () => fetchCount };
}

test('delayed Gmail token refresh rechecks revoked consent before fetch', async () => {
  const { service, context, campaign, fetchCount } = racingService(async (domain) => domain.syncSuppression(context, 'contact-1', 'UNSUBSCRIBED'));
  const result = await service.dispatchCampaign(context, campaign.id);
  assert.equal(fetchCount(), 0);
  assert.equal(result.outcomes[0].status, 'cancelled');
  assert.equal(result.outcomes[0].reason, 'UNSUBSCRIBED');
});

test('delayed Gmail token refresh rechecks a paused campaign before fetch', async () => {
  const { service, context, campaign, fetchCount } = racingService(async (domain) => domain.pauseCampaign(context, campaign.id));
  const result = await service.dispatchCampaign(context, campaign.id);
  assert.equal(fetchCount(), 0);
  assert.equal(result.outcomes[0].status, 'cancelled');
  assert.equal(result.outcomes[0].reason, 'CAMPAIGN_PAUSED_OR_APPROVAL_STALE');
});

test('changed Gmail identity after token refresh refuses the request and keeps From pinned', async () => {
  let liveIdentity = { connectionId: 'connection-a', accountId: 'google-subject-a', email: 'sender@example.com' };
  let fetchCount = 0;
  const adapter = createGmailApiAdapter({
    getAccessToken: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      liveIdentity = { connectionId: 'connection-b', accountId: 'google-subject-b', email: 'other@example.com' };
      return 'fixture-token';
    },
    connectionIdentity: () => liveIdentity,
    fetchImpl: async () => { fetchCount += 1; return { ok: true, json: async () => ({ id: 'message' }) }; },
  });
  const expectedConnectionIdentity = { ...liveIdentity };
  await assert.rejects(adapter.send({ message: { to: 'recipient@example.com', subject: 'Hi', plainText: 'Hi', html: '<p>Hi</p>', unsubscribeUrl: 'https://example.com/unsubscribe' }, tenantId: 'tenant-a', businessId: 'business-a', expectedConnectionIdentity }), {
    code: 'GMAIL_SENDER_CHANGED', safeToRetry: true,
  });
  assert.equal(fetchCount, 0);
});

test('Gmail adapter preserves a durable storage failure from the token owner', async () => {
  const storageFailure = Object.assign(new Error('durable store is unavailable'), { code: 'STORE_PERSISTENCE_FAILED' });
  let fetchCount = 0;
  const adapter = createGmailApiAdapter({
    getAccessToken: async () => { throw storageFailure; },
    connectionIdentity: () => ({ connectionId: 'connection-a', accountId: 'google-subject-a', email: 'sender@example.com' }),
    fetchImpl: async () => { fetchCount += 1; return { ok: true, json: async () => ({ id: 'message' }) }; },
  });
  await assert.rejects(adapter.send({
    message: { to: 'recipient@example.com', subject: 'Hi', plainText: 'Hi', html: '<p>Hi</p>', unsubscribeUrl: 'https://example.com/unsubscribe' },
    tenantId: 'tenant-a', businessId: 'business-a',
    expectedConnectionIdentity: { connectionId: 'connection-a', accountId: 'google-subject-a', email: 'sender@example.com' },
  }), (error) => error === storageFailure);
  assert.equal(fetchCount, 0);
});
