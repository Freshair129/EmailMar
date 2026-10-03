import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EmailMarError } from '../domain/errors.mjs';

export const LOCAL_CONTEXT = Object.freeze({
  tenantId: 'emailmar-local', businessId: 'emailmar-local', actorId: 'local-operator', actorType: 'human',
  inputSource: 'EMAILMAR_LOCAL',
  permissions: Object.freeze(['campaign.read', 'campaign.write', 'campaign.approve', 'campaign.schedule',
    'campaign.pause', 'campaign.worker', 'template.write', 'template.read', 'crm.read', 'crm.projection.write',
    'files.read', 'files.projection.write', 'integration.read', 'integration.write', 'dag.read', 'dag.write',
    'dag.worker', 'dag.gate']),
});

const COOKIE = 'emailmar_session';
const TTL = 8 * 60 * 60 * 1000;
export const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const deny = (message) => { throw new EmailMarError('LOCAL_SESSION_FORBIDDEN', message, 403); };

export function assertLocalRequest(request, mutation = false, allowDocumentNavigation = false) {
  if (!isLoopback(request.socket.remoteAddress)) deny('Standalone access is restricted to this computer.');
  let origin;
  try {
    const url = new URL(`http://${request.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') deny('Invalid local host.');
    origin = url.origin;
  } catch { deny('Invalid local host.'); }
  const documentNavigation = allowDocumentNavigation && !mutation && request.method === 'GET' && request.url === '/'
    && request.headers['sec-fetch-site'] === 'cross-site' && request.headers['sec-fetch-mode'] === 'navigate'
    && request.headers['sec-fetch-dest'] === 'document' && request.headers['sec-fetch-user'] === '?1';
  if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']) && !documentNavigation) deny('Cross-site requests are not permitted.');
  if ((mutation || request.headers.origin) && request.headers.origin !== origin) deny('A same-origin request is required.');
}

export function assertLocalCallbackRequest(request, callbackOrigin) {
  if (!isLoopback(request.socket.remoteAddress)) deny('OAuth callbacks are restricted to this computer.');
  let origin;
  try {
    const protocol = request.socket.encrypted ? 'https:' : 'http:';
    const url = new URL(`${protocol}//${request.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') deny('Invalid local host.');
    origin = url.origin;
  } catch { deny('Invalid local host.'); }
  if (callbackOrigin && origin !== callbackOrigin) deny(`Open the callback on its configured local origin: ${callbackOrigin}.`);
  if (request.headers.origin && request.headers.origin !== origin) deny('A same-origin callback is required.');
}

export class LocalSessions {
  constructor({ clock = Date.now } = {}) { this.sessions = new Map(); this.clock = clock; }

  #lookup(request) {
    const token = String(request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = token && this.sessions.get(token);
    if (!session || session.expiresAt <= this.clock()) { if (token) this.sessions.delete(token); return null; }
    return session;
  }

  open(request, response) {
    assertLocalRequest(request, true);
    if (request.headers['x-emailmar-client'] !== 'standalone-ui') deny('Use the local EmailMar interface.');
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.clock()) this.sessions.delete(key);
    let session = this.#lookup(request);
    if (!session) {
      if (this.sessions.size >= 100) deny('Too many local sessions. Restart the service to clear them.');
      const token = randomBytes(32).toString('hex');
      session = { csrfToken: randomBytes(32).toString('hex'), expiresAt: this.clock() + TTL };
      this.sessions.set(token, session);
      response.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`);
    }
    return { csrfToken: session.csrfToken, expiresAt: session.expiresAt, operator: 'ผู้ดูแลบนเครื่องนี้', mode: 'standalone' };
  }

  authorize(request) {
    const mutation = !['GET', 'HEAD'].includes(request.method);
    assertLocalRequest(request, mutation);
    const session = this.#lookup(request);
    if (!session) return null;
    if (mutation) {
      const supplied = Buffer.from(String(request.headers['x-csrf-token'] ?? ''));
      const expected = Buffer.from(session.csrfToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) deny('Session verification failed. Reopen the local interface.');
    }
    return LOCAL_CONTEXT;
  }

  close(request, response) {
    if (!this.authorize(request)) throw new EmailMarError('UNAUTHORIZED', 'Session expired.', 401);
    const token = String(request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    this.sessions.delete(token);
    response.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }
}
