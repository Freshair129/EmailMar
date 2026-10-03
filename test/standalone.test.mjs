import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { LocalSessions, LOCAL_CONTEXT, assertLocalRequest } from '../src/http/local-session.mjs';
import { createEmailMarServer } from '../src/http/server.mjs';
import { EmailMarService } from '../src/domain/emailmar-service.mjs';

const human = { ...LOCAL_CONTEXT, permissions: ['*'] };
function seed(service, context = human) {
  service.createTemplate(context, { id: 't', version: 1, subject: 'Hello {{name}}', html: '<p>Hello {{name}}</p>', plainText: 'Hello {{name}}', variables: ['name'] });
  service.upsertRecipient(context, { id: 'r', displayName: 'Recipient', email: 'recipient@example.com', consents: [{ type: 'EMAIL_MARKETING', status: 'GRANTED' }] });
  return service.createCampaignDraft(context, { name: 'Local campaign', templateId: 't', templateVersion: 1, recipientIds: ['r'], recipientVariables: { r: { name: 'Recipient' } }, attachmentIds: [] });
}
const fakeGmail = () => ({ send: async () => ({ accepted: true, providerMessageId: 'fixture-id' }) });

const documentNavigationHeaders = {
  'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document', 'sec-fetch-user': '?1',
};

test('root document navigation requires explicit opt-in and keeps peer, Host and Origin checks', () => {
  const request = { method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:8788', ...documentNavigationHeaders } };
  assert.throws(() => assertLocalRequest(request), { code: 'LOCAL_SESSION_FORBIDDEN' });
  assert.doesNotThrow(() => assertLocalRequest(request, false, true));
  for (const changed of [
    { socket: { remoteAddress: '192.168.1.2' } },
    { headers: { ...request.headers, host: 'evil.example' } },
    { headers: { ...request.headers, origin: 'http://127.0.0.1:4319' } },
    { method: 'POST' }, { method: 'HEAD' },
    { url: '/?campaign=fixture' }, { url: '/?' }, { url: '/ui/app.mjs' },
  ]) assert.throws(() => assertLocalRequest({ ...request, ...changed }, false, true), { code: 'LOCAL_SESSION_FORBIDDEN' });
  assert.throws(() => assertLocalRequest(request, true, true), { code: 'LOCAL_SESSION_FORBIDDEN' });
  for (const [field, wrong] of [['sec-fetch-mode', 'cors'], ['sec-fetch-dest', 'iframe'], ['sec-fetch-user', '?0'], ['sec-fetch-site', 'same-site']]) {
    const missing = { ...request.headers }; delete missing[field];
    if (field !== 'sec-fetch-site') assert.throws(() => assertLocalRequest({ ...request, headers: missing }, false, true), { code: 'LOCAL_SESSION_FORBIDDEN' });
    assert.throws(() => assertLocalRequest({ ...request, headers: { ...request.headers, [field]: wrong } }, false, true), { code: 'LOCAL_SESSION_FORBIDDEN' });
  }
  for (const site of ['none', 'same-origin']) assert.doesNotThrow(() => assertLocalRequest({ ...request, headers: { ...request.headers, 'sec-fetch-site': site } }));
});

test('cross-site navigation exception cannot open or authorize a standalone session', () => {
  const sessions = new LocalSessions();
  const request = { method: 'POST', url: '/ui/session', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:8788', origin: 'http://localhost:8788', 'x-emailmar-client': 'standalone-ui' } };
  let cookie;
  const opened = sessions.open(request, { setHeader: (name, value) => { if (name === 'set-cookie') cookie = value.split(';')[0]; } });
  const crossSite = { ...request, headers: { ...request.headers, ...documentNavigationHeaders, cookie, 'x-csrf-token': opened.csrfToken } };
  assert.throws(() => sessions.open(crossSite, { setHeader: () => assert.fail('cross-site session cookie') }), { code: 'LOCAL_SESSION_FORBIDDEN' });
  for (const method of ['GET', 'POST']) assert.throws(() => sessions.authorize({ ...crossSite, method }), { code: 'LOCAL_SESSION_FORBIDDEN' });
  assert.equal(sessions.sessions.size, 1);
});

test('standalone HTTP permits only the cross-site root document and performs no service operation', async () => {
  const service = new Proxy({}, { get: () => assert.fail('static navigation must not access the service') });
  const server = createEmailMarServer({ service, standalone: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Node fetch overwrites Sec-Fetch-Mode with cors; raw HTTP preserves browser fixture metadata.
  const request = (path, options) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    req.on('error', reject); req.end();
  });
  try {
    const headers = { ...documentNavigationHeaders };
    const page = await request('/', { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html lang="th">/);
    assert.equal(page.headers.get('set-cookie'), null);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    for (const path of ['/?payload=fixture', '/ui/app.mjs', '/ui/demo.mjs', '/ui/styles.css', '/ui/dags.css', '/v1/workspace']) {
      assert.equal((await request(path, { headers })).status, 403, path);
    }
    for (const path of ['/ui/session', '/ui/logout', '/v1/templates']) {
      assert.equal((await request(path, { method: 'POST', headers: { ...headers, origin: base, 'x-emailmar-client': 'standalone-ui' } })).status, 403, path);
    }
    for (const changed of [{ 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-user': '' }, { origin: 'http://127.0.0.1:4319' }, { host: 'evil.example' }]) {
      assert.equal((await request('/', { headers: { ...headers, ...changed } })).status, 403);
    }
    assert.equal((await request('/mcp', { method: 'POST', headers })).status, 401);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('local sessions enforce loopback, Host, Origin, CSRF and expiry', () => {
  let now = 1000;
  const sessions = new LocalSessions({ clock: () => now });
  const request = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788', 'x-emailmar-client': 'standalone-ui' } };
  let cookie;
  const session = sessions.open(request, { setHeader: (name, value) => { if (name === 'set-cookie') cookie = value; } });
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  request.headers.cookie = cookie.split(';')[0];
  assert.throws(() => sessions.authorize(request), { code: 'LOCAL_SESSION_FORBIDDEN' });
  request.headers['x-csrf-token'] = session.csrfToken;
  assert.equal(sessions.authorize(request).actorType, 'human');
  for (const changed of [{ socket: { remoteAddress: '192.168.1.2' } }, { headers: { ...request.headers, host: 'evil.example' } }, { headers: { ...request.headers, origin: 'https://evil.example' } }, { headers: { ...request.headers, 'sec-fetch-site': 'cross-site' } }]) {
    assert.throws(() => assertLocalRequest({ ...request, ...changed }, true), { code: 'LOCAL_SESSION_FORBIDDEN' });
  }
  now = session.expiresAt;
  assert.equal(sessions.authorize(request), null);
});

test('workspace projection exposes only the authorized tenant and business', () => {
  const service = new EmailMarService();
  seed(service);
  const other = { ...human, businessId: 'different-business' };
  const otherCampaign = seed(service, other);
  const data = service.getWorkspace(human);
  assert.equal(data.campaigns.length, 1);
  assert.equal(data.recipients.length, 1);
  assert.equal(data.templates.length, 1);
  assert.ok(data.audit.every((e) => e.businessId === human.businessId));
  assert.throws(() => service.getCampaign(human, otherCampaign.id), { code: 'NOT_FOUND' });
  assert.throws(() => service.getWorkspace({ ...human, permissions: ['campaign.read'] }), { code: 'FORBIDDEN' });
});

test('immediate scheduling works with an advancing clock and repeated schedule is idempotent', () => {
  let time = Date.parse('2026-09-24T10:00:00Z');
  const service = new EmailMarService({ clock: () => new Date(time++) });
  const c = seed(service);
  service.approveCampaign(human, c.id);
  const result = service.scheduleCampaign(human, c.id);
  assert.equal(result.queued, 1);
  const originalAt = service.getCampaignReport(human, c.id).queue[0].scheduledAt;
  time += 10_000;
  assert.deepEqual(service.scheduleCampaign(human, c.id, { scheduledAt: originalAt }).queueIds, result.queueIds);
  assert.equal(service.store.queue.size, 1);
});

test('manual dispatch rejects AI and absent adapters without consuming the queue', () => {
  const service = new EmailMarService();
  const c = seed(service);
  service.approveCampaign(human, c.id);
  service.scheduleCampaign(human, c.id);
  assert.throws(() => service.dispatchCampaign({ ...human, actorType: 'ai' }, c.id), { code: 'HUMAN_DISPATCH_REQUIRED' });
  assert.throws(() => service.dispatchCampaign(human, c.id), { code: 'GMAIL_NOT_CONFIGURED' });
  assert.equal(service.getCampaignReport(human, c.id).queue[0].status, 'pending');
});

test('manual dispatch only processes the selected campaign', async () => {
  const service = new EmailMarService({ gmail: fakeGmail() });
  const first = seed(service);
  const second = service.createCampaignDraft(human, { ...first.draft, name: 'Another campaign' });
  for (const c of [first, second]) { service.approveCampaign(human, c.id); service.scheduleCampaign(human, c.id); }
  const result = await service.dispatchCampaign(human, first.id);
  assert.equal(result.considered, 1);
  assert.equal(service.getCampaignReport(human, first.id).queue[0].status, 'accepted_by_gmail');
  assert.equal(service.getCampaignReport(human, second.id).queue[0].status, 'pending');
});

test('consent is rechecked after asynchronous attachment resolution', async () => {
  let sends = 0, release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const bytes = Buffer.from('fixture attachment');
  const service = new EmailMarService({ gmail: { send: async () => { sends++; return { accepted: true, providerMessageId: 'fixture-id' }; } }, files: { resolveBytes: async () => { entered(); await gate; return bytes; } } });
  const c = seed(service);
  service.registerAttachment(human, { id: 'a', fileRef: 'files:fixture', sha256: createHash('sha256').update(bytes).digest('hex'), filename: 'fixture.txt', mimeType: 'text/plain', size: bytes.length, version: 1 });
  service.updateCampaignDraft(human, c.id, { attachmentIds: ['a'] });
  service.approveCampaign(human, c.id); service.scheduleCampaign(human, c.id);
  const dispatch = service.dispatchCampaign(human, c.id);
  await started;
  service.upsertRecipient(human, { id: 'r', displayName: 'Recipient', email: 'recipient@example.com', consents: [] });
  release(); await dispatch;
  assert.equal(sends, 0);
  assert.equal(service.getCampaignReport(human, c.id).queue[0].status, 'cancelled');
});

test('standalone HTTP UI and CRUD share authorization, approval and suppression gates', async () => {
  const service = new EmailMarService();
  const server = createEmailMarServer({ service, standalone: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html lang="th">/);
    for (const path of ['/ui/app.mjs', '/ui/styles.css']) assert.equal((await fetch(base + path)).status, 200);
    assert.equal((await fetch(base + '/v1/workspace')).status, 401);
    const sessionResponse = await fetch(base + '/ui/session', { method: 'POST', headers: { origin: base, 'x-emailmar-client': 'standalone-ui' } });
    assert.equal(sessionResponse.status, 200);
    const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await sessionResponse.json();
    const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
    const request = (path, body, method = 'POST', extraHeaders = {}) => fetch(base + path, { method, headers: { ...headers, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
    assert.equal((await request('/v1/templates', {}, 'POST', { 'x-csrf-token': '' })).status, 403);
    assert.equal((await request('/v1/templates', {}, 'POST', { origin: 'http://evil.example' })).status, 403);
    assert.equal((await request('/v1/templates', { id: 't', version: 1, subject: 'Subject', html: '<p>Content</p>', plainText: 'Content', variables: [] })).status, 201);
    assert.equal((await request('/v1/recipients', { id: 'r', displayName: 'Local fixture', email: 'local@example.com', consents: [{ type: 'EMAIL_MARKETING', status: 'GRANTED' }] })).status, 200);
    const draft = { name: 'HTTP fixture', templateId: 't', templateVersion: 1, recipientIds: ['r'], recipientVariables: {}, attachmentIds: [] };
    assert.equal((await request('/v1/campaigns', { ...draft, tenantId: 'spoofed' })).status, 400);
    const c = await (await request('/v1/campaigns', draft)).json();
    const path = `/v1/campaigns/${c.id}`;
    assert.equal((await request(path + '/schedule', {})).status, 409);
    let preview = await (await request(path + '/preview', {})).json();
    assert.equal((await request(path + '/approve', { draftHash: preview.draftHash })).status, 200);
    assert.equal((await request(path, { name: 'Updated' }, 'PATCH')).status, 200);
    assert.equal((await request(path + '/schedule', {})).status, 409);
    assert.equal((await request(path + '/approve', { draftHash: preview.draftHash })).status, 409);
    preview = await (await request(path + '/preview', {})).json();
    await request(path + '/approve', { draftHash: preview.draftHash });
    assert.equal((await request(path + '/schedule', {})).status, 200);
    assert.equal((await request(path + '/dispatch', {})).status, 503);
    const report = await (await request(path + '/report', undefined, 'GET')).json();
    assert.equal(report.queue[0].status, 'pending'); assert.equal(report.humanReadClaim, false);
    await request('/v1/recipients/r/suppression', { reason: 'MANUAL_SUPPRESSION' });
    const data = await (await request('/v1/workspace', undefined, 'GET')).json();
    assert.equal(data.recipients[0].eligible, false);
    assert.ok(data.audit.some((e) => e.action === 'campaign.approved'));
    assert.equal((await request('/ui/logout', {})).status, 200);
    assert.equal((await request('/v1/workspace', undefined, 'GET')).status, 401);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
