import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  GMAIL_OAUTH_ENV_FIELDS,
  GMAIL_OAUTH_SCOPES,
  GmailConnections,
} from '../src/integrations/gmail-oauth.mjs';

const ACCESS_TOKEN = 'fixture-access-token';
const REFRESH_TOKEN = 'fixture-refresh-token';
const REFRESHED_TOKEN = 'fixture-refreshed-access-token';
const CLIENT_ID = 'fixture-google-client-id';
const CLIENT_SECRET = 'fixture-google-client-secret';
const ENCRYPTION_KEY = Buffer.alloc(32, 0x5a);
const REDIRECT_URI = 'http://127.0.0.1:3000/v1/integrations/gmail/callback';
const CONTEXT = Object.freeze({
  tenantId: 'tenant-alpha',
  businessId: 'business-alpha',
  actorId: 'human-operator',
  actorType: 'human',
  permissions: ['integration.read', 'integration.write'],
});
const OTHER_CONTEXT = Object.freeze({ ...CONTEXT, tenantId: 'tenant-beta', businessId: 'business-beta' });
const SESSION_BINDING = 'fixture-callback-nonce-012345678901234567890123';
const ACCOUNT_SUBJECT = 'fixture-google-subject-alpha';
const EMAIL_SCOPE_ALIAS = 'https://www.googleapis.com/auth/userinfo.email';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const FULL_ALIAS_SCOPES = `openid ${EMAIL_SCOPE_ALIAS} ${SEND_SCOPE}`;

function createStore() {
  return {
    connections: new Map(),
    audit: [],
    checkpointCount: 0,
    failCheckpoint: false,
    unhealthy: false,
    assertHealthy() {
      if (this.unhealthy) throw new Error('fixture storage detail must not escape');
    },
    checkpoint() {
      this.checkpointCount += 1;
      if (this.failCheckpoint) throw new Error('fixture persistence detail must not escape');
    },
  };
}

function jsonResponse(value, { ok = true, status = ok ? 200 : 400 } = {}) {
  return { ok, status, async json() { return value; } };
}

function createProvider({
  subject = ACCOUNT_SUBJECT,
  email = 'operator@example.test',
  scope = FULL_ALIAS_SCOPES,
  authTokens = {},
  refreshTokens = {},
  refreshHandler,
} = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'authorization_code') {
        return jsonResponse({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
          scope,
          ...authTokens,
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (refreshHandler) return refreshHandler({ form, init, calls });
        return jsonResponse({
          access_token: REFRESHED_TOKEN,
          expires_in: 3600,
          scope,
          ...refreshTokens,
        });
      }
      assert.fail('Unexpected token grant type.');
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, `Bearer ${authTokens.access_token ?? ACCESS_TOKEN}`);
      return jsonResponse({ sub: subject, email, email_verified: true });
    }
    assert.fail(`Unexpected provider endpoint: ${url}`);
  };
  return { fetchImpl, calls };
}

function createManager({ store = createStore(), provider = createProvider(), clock = () => Date.now(), ...overrides } = {}) {
  const manager = new GmailConnections({
    store,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    encryptionKey: ENCRYPTION_KEY,
    fetchImpl: provider.fetchImpl,
    clock,
    ...overrides,
  });
  return { manager, store, provider };
}

async function start(manager, context = CONTEXT, sessionBinding = SESSION_BINDING) {
  const result = await manager.start(context, { sessionBinding });
  const authorizationUrl = new URL(result.authorizationUrl);
  return { ...result, authorizationUrl, state: authorizationUrl.searchParams.get('state') };
}

async function connect(manager, context = CONTEXT, sessionBinding = SESSION_BINDING) {
  const started = await start(manager, context, sessionBinding);
  const result = await manager.complete({ state: started.state, code: 'fixture-auth-code', sessionBinding });
  return { started, result };
}

function assertSafeError(error, code, forbiddenText = []) {
  assert.equal(error.code, code);
  for (const value of forbiddenText) {
    assert.equal(String(error.message).includes(value), false);
    assert.equal(JSON.stringify(error).includes(value), false);
  }
}

test('authorization uses state, S256 PKCE, fixed HTTPS endpoints, minimal scopes, and a verified Google account', async () => {
  const { manager, store, provider } = createManager();
  const started = await start(manager);
  assert.equal(started.authorizationUrl.origin, 'https://accounts.google.com');
  assert.equal(started.authorizationUrl.pathname, '/o/oauth2/v2/auth');
  assert.equal(started.authorizationUrl.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(started.authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(started.authorizationUrl.searchParams.get('scope'), GMAIL_OAUTH_SCOPES.join(' '));
  assert.equal(started.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(started.authorizationUrl.searchParams.get('access_type'), 'offline');
  assert.equal(started.authorizationUrl.searchParams.get('prompt'), 'consent select_account');

  const connected = await manager.complete({ state: started.state, code: 'fixture-auth-code', sessionBinding: SESSION_BINDING });
  const tokenCall = provider.calls.find((call) => call.url === 'https://oauth2.googleapis.com/token');
  const tokenForm = new URLSearchParams(tokenCall.init.body);
  const expectedChallenge = createHash('sha256').update(tokenForm.get('code_verifier')).digest('base64url');
  assert.equal(started.authorizationUrl.searchParams.get('code_challenge'), expectedChallenge);
  assert.equal(connected.status, 'CONNECTED');
  assert.equal(connected.email, 'operator@example.test');
  assert.equal(connected.scopes.includes('email'), true);
  assert.equal(connected.scopes.includes(EMAIL_SCOPE_ALIAS), false);
  assert.equal(store.connections.size, 1);
  assert.equal(provider.calls.some((call) => call.url === 'https://openidconnect.googleapis.com/v1/userinfo'), true);
  assert.equal(manager.callbackOrigin, 'http://127.0.0.1:3000');
});

test('state is one-time, short-lived, and bound to the initiating callback nonce and scope', async () => {
  let now = 1_800_000_000_000;
  const { manager, store } = createManager({ clock: () => now });
  const started = await start(manager);
  await assert.rejects(
    manager.complete({ state: started.state, code: 'fixture-auth-code', sessionBinding: 'another-callback-nonce-01234567890123456789' }),
    (error) => error.code === 'GMAIL_OAUTH_BINDING_MISMATCH',
  );
  await manager.complete({ state: started.state, error: 'access_denied', sessionBinding: SESSION_BINDING });
  await assert.rejects(
    manager.complete({ state: started.state, code: 'fixture-auth-code', sessionBinding: SESSION_BINDING }),
    (error) => error.code === 'GMAIL_OAUTH_STATE_INVALID',
  );
  assert.equal(store.connections.size, 0);

  const expired = await start(manager);
  now += 10 * 60 * 1000 + 1;
  await assert.rejects(
    manager.complete({ state: expired.state, code: 'fixture-auth-code', sessionBinding: SESSION_BINDING }),
    (error) => error.code === 'GMAIL_OAUTH_STATE_EXPIRED',
  );
});

test('provider cancellation and malformed provider errors stay safe and consume matching state', async () => {
  const { manager } = createManager();
  const cancelled = await start(manager);
  const outcome = await manager.complete({ state: cancelled.state, error: 'access_denied', sessionBinding: SESSION_BINDING });
  assert.equal(outcome.status, 'DISCONNECTED');
  assert.equal(outcome.outcome, 'CANCELLED');

  const malformed = await start(manager);
  const providerText = `fixture-refresh-secret-${REFRESH_TOKEN}`;
  await assert.rejects(
    manager.complete({ state: malformed.state, error: `access_denied ${providerText}`, sessionBinding: SESSION_BINDING }),
    (error) => {
      assertSafeError(error, 'GMAIL_OAUTH_CALLBACK_FAILED', [providerText, REFRESH_TOKEN]);
      return true;
    },
  );
  await assert.rejects(
    manager.complete({ state: malformed.state, error: 'access_denied', sessionBinding: SESSION_BINDING }),
    (error) => error.code === 'GMAIL_OAUTH_STATE_INVALID',
  );
});

test('configuration status exposes only canonical environment field names', async () => {
  const store = createStore();
  const manager = new GmailConnections({ store, clientId: 'private-fixture-value' });
  const status = manager.status(CONTEXT);
  assert.deepEqual(status, {
    status: 'NOT_CONFIGURED',
    missingFields: [
      GMAIL_OAUTH_ENV_FIELDS.clientSecret,
      GMAIL_OAUTH_ENV_FIELDS.redirectUri,
      GMAIL_OAUTH_ENV_FIELDS.encryptionKey,
    ],
  });
  assert.equal(JSON.stringify(status).includes('private-fixture-value'), false);
  await assert.rejects(manager.start(CONTEXT, { sessionBinding: SESSION_BINDING }), (error) => {
    assertSafeError(error, 'GMAIL_OAUTH_NOT_CONFIGURED', ['private-fixture-value']);
    assert.deepEqual(error.missingFields, [
      GMAIL_OAUTH_ENV_FIELDS.clientSecret,
      GMAIL_OAUTH_ENV_FIELDS.redirectUri,
      GMAIL_OAUTH_ENV_FIELDS.encryptionKey,
    ]);
    return true;
  });
});

test('token envelopes are encrypted and authenticated to tenant/business scope across manager instances', async () => {
  const { manager, store } = createManager();
  await connect(manager);
  const key = JSON.stringify([CONTEXT.tenantId, CONTEXT.businessId]);
  const record = store.connections.get(key);
  assert.equal(typeof record.encryptedTokens.ciphertext, 'string');
  assert.equal(JSON.stringify(record).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(record).includes(REFRESH_TOKEN), false);
  assert.equal(JSON.stringify(manager.status(CONTEXT)).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(store.audit).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(store.audit).includes(REFRESH_TOKEN), false);

  const restarted = new GmailConnections({
    store,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    encryptionKey: ENCRYPTION_KEY,
    fetchImpl: async () => assert.fail('A still-valid access token must not refresh.'),
  });
  assert.equal(await restarted.getAccessToken({ ...CONTEXT, provider: 'gmail' }), ACCESS_TOKEN);
  assert.deepEqual(restarted.connectionIdentity(CONTEXT), {
    connectionId: record.connectionId,
    accountId: ACCOUNT_SUBJECT,
    email: 'operator@example.test',
  });
  assert.equal(restarted.validateConnectionIdentity({ ...CONTEXT, expectedConnectionIdentity: restarted.connectionIdentity(CONTEXT) }), true);
  assert.equal(restarted.validateConnectionIdentity({ ...CONTEXT, expectedConnectionIdentity: { connectionId: record.connectionId } }), false);

  store.connections.set(JSON.stringify([OTHER_CONTEXT.tenantId, OTHER_CONTEXT.businessId]), record);
  await assert.rejects(
    restarted.getAccessToken({ tenantId: OTHER_CONTEXT.tenantId, businessId: OTHER_CONTEXT.businessId }),
    (error) => error.code === 'GMAIL_TOKEN_UNAVAILABLE',
  );
});

test('scope mismatch fails closed before connection metadata or tokens are stored', async () => {
  const provider = createProvider({ scope: 'openid email' });
  const { manager, store } = createManager({ provider });
  const started = await start(manager);
  await assert.rejects(
    manager.complete({ state: started.state, code: 'fixture-auth-code', sessionBinding: SESSION_BINDING }),
    (error) => error.code === 'GMAIL_OAUTH_SCOPE_MISMATCH',
  );
  assert.equal(store.connections.size, 0);
  assert.equal(store.audit.length, 0);
});

test('a different Google account cannot replace an existing connection without disconnect', async () => {
  const store = createStore();
  const firstProvider = createProvider();
  const { manager } = createManager({ store, provider: firstProvider });
  await connect(manager);
  const before = manager.connectionIdentity(CONTEXT);

  const secondProvider = createProvider({ subject: 'fixture-google-subject-beta', email: 'other@example.test' });
  const secondManager = new GmailConnections({
    store,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    encryptionKey: ENCRYPTION_KEY,
    fetchImpl: secondProvider.fetchImpl,
  });
  const started = await start(secondManager, CONTEXT, 'fixture-callback-nonce-abcdefghijklmnopqrstuvwxyz');
  await assert.rejects(
    secondManager.complete({ state: started.state, code: 'fixture-auth-code', sessionBinding: 'fixture-callback-nonce-abcdefghijklmnopqrstuvwxyz' }),
    (error) => error.code === 'GMAIL_ACCOUNT_CHANGE_REQUIRES_DISCONNECT',
  );
  assert.deepEqual(secondManager.connectionIdentity(CONTEXT), before);
});

test('refresh is single-flight and preserves the pinned connection identity', async () => {
  let now = 1_800_000_000_000;
  let refreshCount = 0;
  let markRefreshStarted;
  let releaseRefresh;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const allowRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const provider = createProvider({
    refreshHandler: async () => {
      refreshCount += 1;
      markRefreshStarted();
      await allowRefresh;
      return jsonResponse({ access_token: REFRESHED_TOKEN, expires_in: 3600, scope: FULL_ALIAS_SCOPES });
    },
  });
  const { manager, store } = createManager({ provider, clock: () => now });
  await connect(manager);
  const expectedConnectionIdentity = manager.connectionIdentity(CONTEXT);
  now += 3600 * 1000;

  const first = manager.getAccessToken({ ...CONTEXT, provider: 'gmail', expectedConnectionIdentity });
  await refreshStarted;
  const second = manager.getAccessToken({ ...CONTEXT, provider: 'gmail', expectedConnectionIdentity });
  releaseRefresh();
  assert.deepEqual(await Promise.all([first, second]), [REFRESHED_TOKEN, REFRESHED_TOKEN]);
  assert.equal(refreshCount, 1);
  assert.deepEqual(manager.connectionIdentity(CONTEXT), expectedConnectionIdentity);
  assert.equal(store.audit.at(-1).action, 'gmail.token_refreshed');
  assert.equal(JSON.stringify(store.audit).includes(REFRESHED_TOKEN), false);
});

test('disconnect prevents an in-flight refresh from restoring the connection', async () => {
  let now = 1_800_000_000_000;
  let markRefreshStarted;
  let releaseRefresh;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const allowRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const provider = createProvider({
    refreshHandler: async () => {
      markRefreshStarted();
      await allowRefresh;
      return jsonResponse({ access_token: REFRESHED_TOKEN, expires_in: 3600, scope: FULL_ALIAS_SCOPES });
    },
  });
  const { manager, store } = createManager({ provider, clock: () => now });
  await connect(manager);
  now += 3600 * 1000;
  const pendingRefresh = manager.getAccessToken({ ...CONTEXT, provider: 'gmail' });
  await refreshStarted;
  assert.deepEqual(manager.disconnect(CONTEXT), { status: 'DISCONNECTED' });
  releaseRefresh();
  await assert.rejects(pendingRefresh, (error) => error.code === 'GMAIL_TOKEN_UNAVAILABLE');
  assert.equal(store.connections.has(JSON.stringify([CONTEXT.tenantId, CONTEXT.businessId])), false);
  assert.equal(manager.status(CONTEXT).status, 'DISCONNECTED');
  assert.equal(store.audit.at(-1).action, 'gmail.disconnected');
});

test('revoked refresh grants are redacted, checkpointed, and require reauthorization', async () => {
  let now = 1_800_000_000_000;
  const privateProviderText = 'fixture provider detail with token fixture-refresh-token';
  const provider = createProvider({
    refreshHandler: async () => jsonResponse({ error: 'invalid_grant', error_description: privateProviderText }, { ok: false }),
  });
  const { manager, store } = createManager({ provider, clock: () => now });
  await connect(manager);
  now += 3600 * 1000;
  await assert.rejects(
    manager.getAccessToken({ ...CONTEXT, provider: 'gmail' }),
    (error) => {
      assertSafeError(error, 'GMAIL_REAUTH_REQUIRED', [privateProviderText, REFRESH_TOKEN]);
      return true;
    },
  );
  assert.equal(manager.status(CONTEXT).status, 'REAUTH_REQUIRED');
  const record = store.connections.get(JSON.stringify([CONTEXT.tenantId, CONTEXT.businessId]));
  assert.equal(record.encryptedTokens, null);
  assert.equal(store.audit.at(-1).action, 'gmail.authorization_revoked');
  assert.equal(JSON.stringify(store.audit).includes(privateProviderText), false);
  assert.equal(store.checkpointCount, 2);
});

test('checkpoint failure rolls back token and audit mutations without exposing store details', async () => {
  const store = createStore();
  store.failCheckpoint = true;
  const { manager } = createManager({ store });
  const started = await start(manager);
  await assert.rejects(
    manager.complete({ state: started.state, code: 'fixture-auth-code', sessionBinding: SESSION_BINDING }),
    (error) => {
      assertSafeError(error, 'GMAIL_CONNECTION_PERSIST_FAILED', ['fixture persistence detail']);
      return true;
    },
  );
  assert.equal(store.connections.size, 0);
  assert.equal(store.audit.length, 0);
});

test('storage health is rechecked after provider awaits before callback persistence or token return', async () => {
  const callbackStore = createStore();
  const callbackProvider = createProvider();
  const callbackFetch = async (url, init) => {
    const response = await callbackProvider.fetchImpl(url, init);
    if (url === 'https://oauth2.googleapis.com/token') callbackStore.unhealthy = true;
    return response;
  };
  const callbackManager = new GmailConnections({
    store: callbackStore,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    encryptionKey: ENCRYPTION_KEY,
    fetchImpl: callbackFetch,
  });
  const started = await start(callbackManager);
  await assert.rejects(
    callbackManager.complete({ state: started.state, code: 'fixture-auth-code', sessionBinding: SESSION_BINDING }),
    (error) => error.code === 'GMAIL_STORAGE_UNAVAILABLE',
  );
  assert.equal(callbackStore.connections.size, 0);
  assert.equal(callbackStore.audit.length, 0);

  let now = 1_800_000_000_000;
  const refreshStore = createStore();
  const refreshProvider = createProvider({
    refreshHandler: async () => {
      refreshStore.unhealthy = true;
      return jsonResponse({ access_token: REFRESHED_TOKEN, expires_in: 3600, scope: FULL_ALIAS_SCOPES });
    },
  });
  const refreshManager = new GmailConnections({
    store: refreshStore,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    encryptionKey: ENCRYPTION_KEY,
    fetchImpl: refreshProvider.fetchImpl,
    clock: () => now,
  });
  await connect(refreshManager);
  const key = JSON.stringify([CONTEXT.tenantId, CONTEXT.businessId]);
  const original = refreshStore.connections.get(key);
  now += 3600 * 1000;
  await assert.rejects(
    refreshManager.getAccessToken({ ...CONTEXT, provider: 'gmail' }),
    (error) => error.code === 'GMAIL_STORAGE_UNAVAILABLE',
  );
  assert.strictEqual(refreshStore.connections.get(key), original);
  assert.equal(refreshStore.audit.at(-1).action, 'gmail.connected');
});

test('start and disconnect require a human with the integration write permission', async () => {
  const { manager } = createManager();
  const agentContext = { ...CONTEXT, actorType: 'agent' };
  await assert.rejects(
    manager.start(agentContext, { sessionBinding: SESSION_BINDING }),
    (error) => error.code === 'GMAIL_OAUTH_HUMAN_REQUIRED',
  );
  assert.throws(
    () => manager.disconnect({ ...CONTEXT, permissions: ['integration.read'] }),
    (error) => error.code === 'FORBIDDEN',
  );
  assert.throws(
    () => manager.status({ ...CONTEXT, permissions: [] }),
    (error) => error.code === 'FORBIDDEN',
  );
});
