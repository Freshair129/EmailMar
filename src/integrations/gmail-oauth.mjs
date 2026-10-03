import {
  createHash, randomBytes, randomUUID, timingSafeEqual,
} from 'node:crypto';
import { requireContext, requirePermission } from '../domain/errors.mjs';
import {
  decryptGmailTokenBundle, encryptGmailTokenBundle, parseGmailEncryptionKey,
} from '../security/gmail-token-vault.mjs';

export const GMAIL_OAUTH_SCOPES = Object.freeze([
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
]);

export const GMAIL_OAUTH_ENV_FIELDS = Object.freeze({
  clientId: 'EMAR_GOOGLE_CLIENT_ID',
  clientSecret: 'EMAR_GOOGLE_CLIENT_SECRET',
  redirectUri: 'EMAR_GOOGLE_REDIRECT_URI',
  encryptionKey: 'EMAR_TOKEN_ENCRYPTION_KEY',
});

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 256;
const REFRESH_SKEW_MS = 30_000;
const TOKEN_AAD_PREFIX = 'emar:gmail:oauth:tokens:v1:';

export class GmailConnectionsError extends Error {
  constructor(code, message, { status = 400, missingFields } = {}) {
    super(message);
    this.name = 'GmailConnectionsError';
    this.code = code;
    this.status = status;
    if (missingFields?.length) this.missingFields = [...missingFields];
  }
}

function safeError(code, message, status = 400, extra = {}) {
  return new GmailConnectionsError(code, message, { status, ...extra });
}

function scopeKey(tenantId, businessId) {
  return JSON.stringify([tenantId, businessId]);
}

function validLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

function isFixedRedirectUri(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && validLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeSameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertSessionBinding(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 256) {
    throw safeError('GMAIL_OAUTH_BINDING_REQUIRED', 'A valid OAuth callback binding is required.', 400);
  }
}

function tokenScopes(value, defaultScopes = GMAIL_OAUTH_SCOPES) {
  if (value === undefined || value === null || value === '') return [...defaultScopes];
  if (typeof value !== 'string') return [];
  return [...new Set(value.trim().split(/\s+/).filter(Boolean).map((scope) => (
    scope === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : scope
  )))];
}

function hasRequiredScopes(scopes) {
  const granted = new Set(scopes);
  return GMAIL_OAUTH_SCOPES.every((scope) => granted.has(scope));
}

function safeConnectionIdentity(record) {
  if (!record || record.status !== 'connected' || !isNonEmptyString(record.connectionId)
    || !isNonEmptyString(record.accountId) || !isNonEmptyString(record.email)) return null;
  return {
    connectionId: record.connectionId,
    accountId: record.accountId,
    email: record.email,
  };
}

function identityMatches(current, expected) {
  if (!current || !expected || typeof expected !== 'object') return false;
  return ['connectionId', 'accountId', 'email'].every((field) => (
    typeof expected[field] === 'string' && expected[field] === current[field]
  ));
}

async function readJson(response) {
  try {
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseExpiresIn(value) {
  const seconds = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export class GmailConnections {
  constructor({
    store,
    clientId,
    clientSecret,
    redirectUri,
    encryptionKey,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
    randomBytesImpl = randomBytes,
    timeoutMs = 10_000,
    stateTtlMs = STATE_TTL_MS,
    maxPendingStates = MAX_PENDING_STATES,
  } = {}) {
    if (!store || (store.connections !== undefined && !(store.connections instanceof Map))
      || !Array.isArray(store.audit) || typeof store.checkpoint !== 'function') {
      throw new TypeError('A store with connections, audit, and checkpoint support is required.');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    if (typeof clock !== 'function' || typeof randomBytesImpl !== 'function') throw new TypeError('Clock and secure randomness functions are required.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('A positive OAuth request timeout is required.');
    this.store = store;
    this.store.connections ??= new Map();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.encryptionKeyInput = encryptionKey;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.randomBytesImpl = randomBytesImpl;
    this.timeoutMs = timeoutMs;
    this.stateTtlMs = stateTtlMs;
    this.maxPendingStates = maxPendingStates;
    this.pendingStates = new Map();
    this.pendingStateByScope = new Map();
    this.scopeRevisions = new Map();
    this.refreshFlights = new Map();
  }

  get callbackOrigin() {
    if (!isFixedRedirectUri(this.redirectUri)) return null;
    return new URL(this.redirectUri).origin;
  }

  static fromEnvironment({ store, env = process.env, ...options } = {}) {
    return new GmailConnections({
      store,
      clientId: env.EMAR_GOOGLE_CLIENT_ID,
      clientSecret: env.EMAR_GOOGLE_CLIENT_SECRET,
      redirectUri: env.EMAR_GOOGLE_REDIRECT_URI,
      encryptionKey: env.EMAR_TOKEN_ENCRYPTION_KEY,
      ...options,
    });
  }

  #configuration() {
    const missingFields = [];
    if (!isNonEmptyString(this.clientId)) missingFields.push(GMAIL_OAUTH_ENV_FIELDS.clientId);
    if (!isNonEmptyString(this.clientSecret)) missingFields.push(GMAIL_OAUTH_ENV_FIELDS.clientSecret);
    if (!isFixedRedirectUri(this.redirectUri)) missingFields.push(GMAIL_OAUTH_ENV_FIELDS.redirectUri);
    const key = parseGmailEncryptionKey(this.encryptionKeyInput);
    if (!key) missingFields.push(GMAIL_OAUTH_ENV_FIELDS.encryptionKey);
    return missingFields.length ? { missingFields } : { key };
  }

  #requireConfigured() {
    const configuration = this.#configuration();
    if (configuration.missingFields) {
      throw safeError('GMAIL_OAUTH_NOT_CONFIGURED', 'Gmail OAuth is not configured.', 503, {
        missingFields: configuration.missingFields,
      });
    }
    return configuration;
  }

  #authorizedScope(context, permission, humanOnly = false) {
    requireContext(context);
    requirePermission(context, permission);
    if (humanOnly && context.actorType !== 'human') {
      throw safeError('GMAIL_OAUTH_HUMAN_REQUIRED', 'A human operator must manage the Gmail connection.', 403);
    }
    if (!isNonEmptyString(context.tenantId) || !isNonEmptyString(context.businessId)
      || !isNonEmptyString(context.actorId)) {
      throw safeError('GMAIL_OAUTH_CONTEXT_INVALID', 'A trusted tenant, business, and actor context is required.', 401);
    }
    return {
      tenantId: context.tenantId,
      businessId: context.businessId,
      actorId: context.actorId,
      actorType: context.actorType,
    };
  }

  #assertHealthy() {
    try {
      this.store.assertHealthy?.();
    } catch {
      throw safeError('GMAIL_STORAGE_UNAVAILABLE', 'Gmail connection storage is unavailable.', 503);
    }
  }

  #configuredStatus(missingFields) {
    return { status: 'NOT_CONFIGURED', missingFields: [...missingFields] };
  }

  #publicStatus(key) {
    const record = this.store.connections.get(key);
    if (!record) return { status: 'DISCONNECTED' };
    if (record.status === 'revoked' || record.status === 'reauth_required' || !record.encryptedTokens
      || !hasRequiredScopes(record.scopes ?? [])) {
      return {
        status: 'REAUTH_REQUIRED',
        email: record.email,
        connectionId: record.connectionId,
        scopes: [...(record.scopes ?? [])],
        connectedAt: record.connectedAt,
      };
    }
    return {
      status: 'CONNECTED',
      email: record.email,
      connectionId: record.connectionId,
      scopes: [...record.scopes],
      connectedAt: record.connectedAt,
    };
  }

  #aad(key) {
    return `${TOKEN_AAD_PREFIX}${key}`;
  }

  #recordMutation({ key, record, action, actorId, details, remove = false, subjectId, tenantId, businessId }) {
    this.#assertHealthy();
    const hadPrevious = this.store.connections.has(key);
    const previous = this.store.connections.get(key);
    const auditLength = this.store.audit.length;
    if (remove) this.store.connections.delete(key);
    else this.store.connections.set(key, record);
    this.store.audit.push({
      id: randomUUID(),
      tenantId: record?.tenantId ?? previous?.tenantId ?? tenantId,
      businessId: record?.businessId ?? previous?.businessId ?? businessId,
      actorId,
      action,
      subjectType: 'gmail_connection',
      subjectId: subjectId ?? record?.connectionId ?? previous?.connectionId ?? 'gmail',
      at: new Date(this.clock()).toISOString(),
      details,
    });
    try {
      this.store.checkpoint();
      this.#assertHealthy();
    } catch {
      if (hadPrevious) this.store.connections.set(key, previous);
      else this.store.connections.delete(key);
      this.store.audit.splice(auditLength);
      throw safeError('GMAIL_CONNECTION_PERSIST_FAILED', 'Gmail connection state could not be saved.', 503);
    }
  }

  #bumpRevision(key) {
    const next = (this.scopeRevisions.get(key) ?? 0) + 1;
    this.scopeRevisions.set(key, next);
    return next;
  }

  #dropPendingForScope(key) {
    const oldState = this.pendingStateByScope.get(key);
    if (oldState) this.pendingStates.delete(oldState);
    this.pendingStateByScope.delete(key);
  }

  #prunePendingStates() {
    const now = this.clock();
    for (const [state, pending] of this.pendingStates) {
      if (pending.expiresAt <= now) {
        this.pendingStates.delete(state);
        if (this.pendingStateByScope.get(pending.scopeKey) === state) this.pendingStateByScope.delete(pending.scopeKey);
      }
    }
  }

  #randomBase64Url(size) {
    const bytes = this.randomBytesImpl(size);
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      throw new TypeError('The secure random generator returned invalid data.');
    }
    return Buffer.from(bytes).toString('base64url');
  }

  async start(context, { sessionBinding } = {}) {
    const scope = this.#authorizedScope(context, 'integration.write', true);
    this.#assertHealthy();
    assertSessionBinding(sessionBinding);
    this.#requireConfigured();
    this.#prunePendingStates();
    if (this.pendingStates.size >= this.maxPendingStates) {
      throw safeError('GMAIL_OAUTH_BUSY', 'Too many Gmail connection attempts are active.', 429);
    }

    const key = scopeKey(scope.tenantId, scope.businessId);
    this.#dropPendingForScope(key);
    const revision = this.#bumpRevision(key);
    const state = this.#randomBase64Url(32);
    const verifier = this.#randomBase64Url(32);
    const expiresAt = this.clock() + this.stateTtlMs;
    this.pendingStates.set(state, {
      scopeKey: key,
      tenantId: scope.tenantId,
      businessId: scope.businessId,
      actorId: scope.actorId,
      actorType: scope.actorType,
      sessionBinding,
      verifier,
      revision,
      expiresAt,
    });
    this.pendingStateByScope.set(key, state);

    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GMAIL_OAUTH_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent select_account');
    return { authorizationUrl: url.toString(), expiresAt };
  }

  async complete({ state, code, error, sessionBinding } = {}) {
    this.#assertHealthy();
    if (typeof state !== 'string' || !state || state.length > 256) {
      throw safeError('GMAIL_OAUTH_CALLBACK_INVALID', 'The Gmail authorization response is invalid.', 400);
    }
    const pending = this.pendingStates.get(state);
    if (!pending) throw safeError('GMAIL_OAUTH_STATE_INVALID', 'The Gmail authorization request is missing, expired, or already used.', 400);
    if (pending.expiresAt <= this.clock()) {
      this.pendingStates.delete(state);
      if (this.pendingStateByScope.get(pending.scopeKey) === state) this.pendingStateByScope.delete(pending.scopeKey);
      throw safeError('GMAIL_OAUTH_STATE_EXPIRED', 'The Gmail authorization request expired. Start again.', 400);
    }
    if (!safeSameSecret(pending.sessionBinding, sessionBinding)) {
      throw safeError('GMAIL_OAUTH_BINDING_MISMATCH', 'The Gmail authorization response belongs to another browser session.', 403);
    }

    this.pendingStates.delete(state);
    if (this.pendingStateByScope.get(pending.scopeKey) === state) this.pendingStateByScope.delete(pending.scopeKey);
    if (typeof error === 'string' && error) {
      if (error === 'access_denied') {
        return { ...this.#publicStatus(pending.scopeKey), outcome: 'CANCELLED' };
      }
      throw safeError('GMAIL_OAUTH_CALLBACK_FAILED', 'Google could not complete the Gmail authorization.', 400);
    }
    if (!isNonEmptyString(code) || code.length > 2048) {
      throw safeError('GMAIL_OAUTH_CALLBACK_INVALID', 'The Gmail authorization response is invalid.', 400);
    }

    const configuration = this.#requireConfigured();
    const currentRevision = this.scopeRevisions.get(pending.scopeKey) ?? 0;
    if (pending.revision !== currentRevision) {
      throw safeError('GMAIL_OAUTH_STATE_INVALID', 'The Gmail authorization request was superseded. Start again.', 409);
    }

    const tokens = await this.#exchangeAuthorizationCode(code, pending.verifier);
    this.#assertHealthy();
    const scopes = tokenScopes(tokens.scope);
    if (!hasRequiredScopes(scopes)) {
      throw safeError('GMAIL_OAUTH_SCOPE_MISMATCH', 'Google did not grant all required Gmail permissions.', 403);
    }
    const account = await this.#fetchVerifiedAccount(tokens.access_token);
    this.#assertHealthy();
    const existing = this.store.connections.get(pending.scopeKey);
    if (existing && existing.accountId !== account.sub) {
      throw safeError('GMAIL_ACCOUNT_CHANGE_REQUIRES_DISCONNECT', 'Disconnect the current Gmail account before connecting a different account.', 409);
    }

    let refreshToken = tokens.refresh_token;
    if (!refreshToken && existing?.accountId === account.sub && existing.encryptedTokens) {
      try {
        refreshToken = decryptGmailTokenBundle(existing.encryptedTokens, configuration.key, this.#aad(pending.scopeKey)).refreshToken;
      } catch {
        refreshToken = null;
      }
    }
    if (!isNonEmptyString(refreshToken)) {
      throw safeError('GMAIL_REFRESH_TOKEN_MISSING', 'Google did not provide offline access. Disconnect and authorize Gmail again.', 502);
    }
    if ((this.scopeRevisions.get(pending.scopeKey) ?? 0) !== pending.revision) {
      throw safeError('GMAIL_OAUTH_STATE_INVALID', 'The Gmail authorization request was superseded. Start again.', 409);
    }

    const expiresIn = parseExpiresIn(tokens.expires_in);
    if (!isNonEmptyString(tokens.access_token) || !expiresIn) {
      throw safeError('GMAIL_TOKEN_EXCHANGE_FAILED', 'Google returned an invalid Gmail token response.', 502);
    }
    const connectedAt = new Date(this.clock()).toISOString();
    const connectionId = randomUUID();
    const record = {
      status: 'connected',
      connectionId,
      tenantId: pending.tenantId,
      businessId: pending.businessId,
      accountId: account.sub,
      email: account.email,
      scopes,
      connectedAt,
      encryptedTokens: encryptGmailTokenBundle({
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt: this.clock() + expiresIn * 1000,
        scopes,
      }, configuration.key, this.#aad(pending.scopeKey), this.randomBytesImpl),
    };
    this.#recordMutation({
      key: pending.scopeKey,
      record,
      action: 'gmail.connected',
      actorId: pending.actorId,
      details: { connectionId, scopes: [...scopes] },
    });
    return this.#publicStatus(pending.scopeKey);
  }

  status(context) {
    const scope = this.#authorizedScope(context, 'integration.read');
    this.#assertHealthy();
    const configuration = this.#configuration();
    if (configuration.missingFields) return this.#configuredStatus(configuration.missingFields);
    return this.#publicStatus(scopeKey(scope.tenantId, scope.businessId));
  }

  disconnect(context) {
    const scope = this.#authorizedScope(context, 'integration.write', true);
    this.#assertHealthy();
    const key = scopeKey(scope.tenantId, scope.businessId);
    this.#dropPendingForScope(key);
    this.#bumpRevision(key);
    const previous = this.store.connections.get(key);
    this.#recordMutation({
      key,
      action: 'gmail.disconnected',
      actorId: scope.actorId,
      details: { wasConnected: Boolean(previous) },
      remove: true,
      tenantId: scope.tenantId,
      businessId: scope.businessId,
    });
    return { status: 'DISCONNECTED' };
  }

  connectionIdentity({ tenantId, businessId } = {}) {
    this.#assertHealthy();
    if (!isNonEmptyString(tenantId) || !isNonEmptyString(businessId)) return null;
    return safeConnectionIdentity(this.store.connections.get(scopeKey(tenantId, businessId)));
  }

  validateConnectionIdentity({ tenantId, businessId, expectedConnectionIdentity } = {}) {
    this.#assertHealthy();
    const current = this.connectionIdentity({ tenantId, businessId });
    return identityMatches(current, expectedConnectionIdentity);
  }

  async getAccessToken({ tenantId, businessId, provider = 'gmail', expectedConnectionIdentity } = {}) {
    this.#assertHealthy();
    if (provider !== 'gmail' || !isNonEmptyString(tenantId) || !isNonEmptyString(businessId)) {
      throw safeError('GMAIL_TOKEN_UNAVAILABLE', 'The Gmail access token is unavailable.', 503);
    }
    const configuration = this.#requireConfigured();
    const key = scopeKey(tenantId, businessId);
    let record = this.store.connections.get(key);
    if (!record || record.status !== 'connected' || !record.encryptedTokens || !hasRequiredScopes(record.scopes ?? [])) {
      throw safeError('GMAIL_TOKEN_UNAVAILABLE', 'The Gmail access token is unavailable. Reconnect the Gmail account.', 503);
    }
    if (expectedConnectionIdentity && !identityMatches(safeConnectionIdentity(record), expectedConnectionIdentity)) {
      throw safeError('GMAIL_CONNECTION_IDENTITY_CHANGED', 'The connected Gmail account no longer matches the approved sender.', 409);
    }

    let bundle;
    try {
      bundle = decryptGmailTokenBundle(record.encryptedTokens, configuration.key, this.#aad(key));
    } catch {
      throw safeError('GMAIL_TOKEN_UNAVAILABLE', 'The encrypted Gmail token is unavailable. Reconnect the Gmail account.', 503);
    }
    if (bundle.expiresAt > this.clock() + REFRESH_SKEW_MS) return bundle.accessToken;

    const currentFlight = this.refreshFlights.get(key);
    if (currentFlight?.connectionId === record.connectionId) return currentFlight.promise;
    const flight = {
      connectionId: record.connectionId,
      promise: this.#refreshAccessToken({ key, record, bundle, configuration, expectedConnectionIdentity }),
    };
    this.refreshFlights.set(key, flight);
    try {
      const accessToken = await flight.promise;
      this.#assertHealthy();
      return accessToken;
    } finally {
      if (this.refreshFlights.get(key) === flight) this.refreshFlights.delete(key);
    }
  }

  async #exchangeAuthorizationCode(code, verifier) {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    let response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw safeError('GMAIL_TOKEN_EXCHANGE_FAILED', 'Google token exchange failed.', 502);
    }
    this.#assertHealthy();
    const result = await readJson(response);
    this.#assertHealthy();
    if (!response.ok || !result || result.error) {
      throw safeError('GMAIL_TOKEN_EXCHANGE_FAILED', 'Google token exchange failed.', 502);
    }
    return result;
  }

  async #fetchVerifiedAccount(accessToken) {
    if (!isNonEmptyString(accessToken)) {
      throw safeError('GMAIL_TOKEN_EXCHANGE_FAILED', 'Google returned an invalid Gmail token response.', 502);
    }
    let response;
    try {
      response = await this.fetchImpl(USERINFO_ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw safeError('GMAIL_ACCOUNT_VERIFICATION_FAILED', 'Google could not verify the connected Gmail account.', 502);
    }
    this.#assertHealthy();
    const result = await readJson(response);
    this.#assertHealthy();
    if (!response.ok || !result || !isNonEmptyString(result.sub) || !isNonEmptyString(result.email)
      || result.email_verified !== true) {
      throw safeError('GMAIL_ACCOUNT_VERIFICATION_FAILED', 'Google could not verify the connected Gmail account.', 502);
    }
    return { sub: result.sub, email: result.email };
  }

  async #refreshAccessToken({ key, record, bundle, configuration, expectedConnectionIdentity }) {
    if (!isNonEmptyString(bundle.refreshToken)) {
      this.#markReauthRequired(key, record);
      throw safeError('GMAIL_TOKEN_UNAVAILABLE', 'The Gmail account needs to be reconnected.', 503);
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: bundle.refreshToken,
      grant_type: 'refresh_token',
    });
    let response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw safeError('GMAIL_TOKEN_REFRESH_FAILED', 'Google could not refresh the Gmail access token.', 503);
    }
    this.#assertHealthy();
    const result = await readJson(response);
    this.#assertHealthy();
    if ((!response.ok || !result || result.error) && result?.error === 'invalid_grant') {
      this.#markRevoked(key, record);
      throw safeError('GMAIL_REAUTH_REQUIRED', 'Google authorization expired or was revoked. Reconnect the Gmail account.', 401);
    }
    if (!response.ok || !result || result.error) {
      throw safeError('GMAIL_TOKEN_REFRESH_FAILED', 'Google could not refresh the Gmail access token.', 503);
    }

    const scopes = tokenScopes(result.scope, bundle.scopes);
    if (!hasRequiredScopes(scopes)) {
      this.#markReauthRequired(key, record);
      throw safeError('GMAIL_OAUTH_SCOPE_MISMATCH', 'Google no longer grants all required Gmail permissions.', 401);
    }
    const expiresIn = parseExpiresIn(result.expires_in);
    if (!isNonEmptyString(result.access_token) || !expiresIn) {
      throw safeError('GMAIL_TOKEN_REFRESH_FAILED', 'Google returned an invalid Gmail token response.', 503);
    }
    if (this.store.connections.get(key) !== record || record.status !== 'connected'
      || (expectedConnectionIdentity && !identityMatches(safeConnectionIdentity(record), expectedConnectionIdentity))) {
      throw safeError('GMAIL_TOKEN_UNAVAILABLE', 'The Gmail connection changed while refreshing. Reauthorize and review the sender before sending.', 503);
    }
    const refreshedBundle = {
      accessToken: result.access_token,
      refreshToken: isNonEmptyString(result.refresh_token) ? result.refresh_token : bundle.refreshToken,
      expiresAt: this.clock() + expiresIn * 1000,
      scopes,
    };
    const refreshedRecord = {
      ...record,
      scopes,
      encryptedTokens: encryptGmailTokenBundle(refreshedBundle, configuration.key, this.#aad(key), this.randomBytesImpl),
    };
    this.#recordMutation({
      key,
      record: refreshedRecord,
      action: 'gmail.token_refreshed',
      actorId: 'emar-gmail-oauth',
      details: { connectionId: record.connectionId },
    });
    return refreshedBundle.accessToken;
  }

  #markRevoked(key, record) {
    if (this.store.connections.get(key) === record) {
      this.#recordMutation({
        key,
        record: { ...record, status: 'revoked', encryptedTokens: null },
        action: 'gmail.authorization_revoked',
        actorId: 'emar-gmail-oauth',
        details: { reason: 'REFRESH_TOKEN_INVALID' },
      });
    }
  }

  #markReauthRequired(key, record) {
    if (this.store.connections.get(key) === record) {
      this.#recordMutation({
        key,
        record: { ...record, status: 'reauth_required', encryptedTokens: null },
        action: 'gmail.reauthorization_required',
        actorId: 'emar-gmail-oauth',
        details: { reason: 'REQUIRED_SCOPE_MISSING' },
      });
    }
  }
}
