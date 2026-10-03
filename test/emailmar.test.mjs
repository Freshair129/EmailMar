import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailMarServer } from '../src/http/server.mjs';
import { EmailMarService } from '../src/domain/emailmar-service.mjs';
import { createGmailApiAdapter } from '../src/adapters/gmail-api.mjs';

const human = {
  tenantId: 'tenant-a', businessId: 'business-a', actorId: 'human-a', actorType: 'human', permissions: ['*'],
};
const otherBusiness = { ...human, tenantId: 'tenant-b', businessId: 'business-b' };

function setup({ gmail, dailyLimit = 500, recipients = ['contact-1'] } = {}) {
  let id = 0;
  let token = 0;
  const now = new Date('2026-09-24T10:00:00.000Z');
  const service = new EmailMarService({
    gmail: gmail ?? { send: async () => ({ accepted: true, providerMessageId: 'fake-id' }) },
    clock: () => new Date(now),
    idFactory: () => `id-${++id}`,
    tokenFactory: () => `token-${++token}`,
    dailyLimit,
  });
  service.createTemplate(human, {
    id: 'welcome', version: 1, subject: 'Hello {{name}}',
    html: '<p>Hello {{name}}</p><a href="https://example.com/offer">Offer</a>',
    plainText: 'Hello {{name}}', variables: ['name'],
  });
  for (const recipientId of recipients) {
    service.upsertRecipient(human, { id: recipientId, email: `${recipientId}@example.com`, consents: [{ type: 'EMAIL_MARKETING', status: 'GRANTED' }] });
  }
  const createCampaign = (ids = recipients, extras = {}) => service.createCampaignDraft(human, {
    name: 'Welcome', templateId: 'welcome', templateVersion: 1, recipientIds: ids,
    recipientVariables: Object.fromEntries(ids.map((recipientId) => [recipientId, { name: 'A <Friend>' }])),
    attachmentIds: [], ...extras,
  });
  return { service, now, createCampaign };
}

async function withServer(options, action) {
  const server = createEmailMarServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { return await action(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('tenant and business scope is checked when reading campaigns', () => {
  const { service, createCampaign } = setup();
  const campaign = createCampaign();
  assert.throws(() => service.getCampaign(otherBusiness, campaign.id), { code: 'NOT_FOUND', status: 404 });
});

test('campaign approval freezes an immutable snapshot and schedule requires approval', () => {
  const { service, createCampaign } = setup();
  const campaign = createCampaign();
  assert.throws(() => service.scheduleCampaign(human, campaign.id), { code: 'APPROVAL_REQUIRED' });
  const preview = service.previewCampaign(human, campaign.id);
  const approval = service.approveCampaign(human, campaign.id, { draftHash: preview.draftHash });
  const stored = service.store.campaigns.get(campaign.id).approval.snapshot;
  assert.equal(approval.payloadHash, preview.draftHash);
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.template), true);
  assert.throws(() => { stored.template.subject = 'changed'; }, TypeError);
  assert.equal(service.scheduleCampaign(human, campaign.id).queued, 1);
});

test('only EMAIL_MARKETING GRANTED recipients are scheduled', () => {
  const { service, createCampaign } = setup();
  service.upsertRecipient(human, { id: 'contact-1', email: 'contact-1@example.com', consents: [{ type: 'TRANSACTIONAL', status: 'GRANTED' }] });
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  const result = service.scheduleCampaign(human, campaign.id);
  assert.equal(result.queued, 0);
  assert.equal(result.withheld.at(-1).reason, 'MARKETING_CONSENT_NOT_GRANTED');
});

test('suppression overrides an otherwise valid marketing consent', () => {
  const { service, createCampaign } = setup();
  service.syncSuppression(human, 'contact-1', 'UNSUBSCRIBED');
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  assert.equal(service.scheduleCampaign(human, campaign.id).queued, 0);
});

test('editing recipients or attachment references after approval requires approval again', () => {
  const { service, createCampaign } = setup();
  service.upsertRecipient(human, { id: 'contact-2', email: 'contact-2@example.com', consents: [{ type: 'EMAIL_MARKETING', status: 'GRANTED' }] });
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  service.updateCampaignDraft(human, campaign.id, { recipientIds: ['contact-2'] });
  assert.throws(() => service.scheduleCampaign(human, campaign.id), { code: 'APPROVAL_REQUIRED' });

  service.approveCampaign(human, campaign.id);
  service.registerAttachment(human, {
    id: 'file-1', fileRef: 'files://tenant-a/business-a/file-1', sha256: 'a'.repeat(64), filename: 'offer.pdf', mimeType: 'application/pdf', size: 1,
  });
  service.updateCampaignDraft(human, campaign.id, { attachmentIds: ['file-1'] });
  assert.throws(() => service.scheduleCampaign(human, campaign.id), { code: 'APPROVAL_REQUIRED' });

  service.createTemplate(human, {
    id: 'welcome', version: 2, subject: 'Updated {{name}}', html: '<p>Updated {{name}}</p>',
    plainText: 'Updated {{name}}', variables: ['name'],
  });
  service.approveCampaign(human, campaign.id);
  service.updateCampaignDraft(human, campaign.id, { templateVersion: 2 });
  assert.throws(() => service.scheduleCampaign(human, campaign.id), { code: 'APPROVAL_REQUIRED' });
});

test('changed recipient address after approval is rejected at schedule time', () => {
  const { service, createCampaign } = setup();
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  service.upsertRecipient(human, { id: 'contact-1', email: 'new-address@example.com', consents: [{ type: 'EMAIL_MARKETING', status: 'GRANTED' }] });
  assert.throws(() => service.scheduleCampaign(human, campaign.id), { code: 'REAPPROVAL_REQUIRED' });
});

test('a human actor is required to approve a campaign', () => {
  const { service, createCampaign } = setup();
  const campaign = createCampaign();
  assert.throws(() => service.approveCampaign({ ...human, actorType: 'agent' }, campaign.id), { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
});

test('daily scheduling cap cannot exceed 500 or configured lower cap', () => {
  const contacts = ['contact-1', 'contact-2', 'contact-3'];
  const { service, createCampaign } = setup({ dailyLimit: 2, recipients: contacts });
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  assert.throws(() => service.scheduleCampaign(human, campaign.id), { code: 'DAILY_LIMIT_EXCEEDED', status: 429 });
  assert.throws(() => new EmailMarService({ dailyLimit: 501 }), { code: 'INVALID_DAILY_LIMIT' });
});

test('daily cap is shared across tenant/business scopes', () => {
  const { service, createCampaign } = setup({ dailyLimit: 1 });
  const first = createCampaign();
  service.approveCampaign(human, first.id);
  service.scheduleCampaign(human, first.id);

  service.createTemplate(otherBusiness, {
    id: 'welcome', version: 1, subject: 'Hello', html: '<p>Hello</p>', plainText: 'Hello', variables: [],
  });
  service.upsertRecipient(otherBusiness, { id: 'contact-1', email: 'other@example.com', consents: [{ type: 'EMAIL_MARKETING', status: 'GRANTED' }] });
  const second = service.createCampaignDraft(otherBusiness, { name: 'Other', templateId: 'welcome', templateVersion: 1, recipientIds: ['contact-1'] });
  service.approveCampaign(otherBusiness, second.id);
  assert.throws(() => service.scheduleCampaign(otherBusiness, second.id), { code: 'DAILY_LIMIT_EXCEEDED', status: 429 });
});

test('duplicate overlapping workers claim and send a queue entry once', async () => {
  let sends = 0;
  let release;
  const { service, createCampaign } = setup({ gmail: { send: () => { sends += 1; return new Promise((resolve) => { release = resolve; }); } } });
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  service.scheduleCampaign(human, campaign.id);
  const first = service.dispatchDue({ ...human, actorType: 'worker', permissions: ['campaign.worker'] });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await service.dispatchDue({ ...human, actorType: 'worker', permissions: ['campaign.worker'] });
  assert.equal(second.considered, 0);
  assert.equal(sends, 1);
  release({ accepted: true });
  assert.equal((await first).outcomes[0].status, 'accepted_by_gmail');
});

test('Gmail timeout becomes SEND_UNKNOWN and is not retried automatically', async () => {
  let sends = 0;
  const { service, createCampaign } = setup({ gmail: { send: async () => { sends += 1; throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } } });
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  service.scheduleCampaign(human, campaign.id);
  const worker = { ...human, actorType: 'worker', permissions: ['campaign.worker'] };
  assert.equal((await service.dispatchDue(worker)).outcomes[0].status, 'SEND_UNKNOWN');
  assert.equal((await service.dispatchDue(worker)).considered, 0);
  assert.equal(sends, 1);
  assert.equal(service.getCampaignReport(human, campaign.id).signals.delivery_unknown, 1);
});

test('suppression arriving after schedule blocks the worker before Gmail', async () => {
  let sends = 0;
  const { service, createCampaign } = setup({ gmail: { send: async () => { sends += 1; return { accepted: true }; } } });
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  service.scheduleCampaign(human, campaign.id);
  service.syncSuppression(human, 'contact-1', 'UNSUBSCRIBED');
  const result = await service.dispatchDue({ ...human, actorType: 'worker', permissions: ['campaign.worker'] });
  assert.equal(result.outcomes[0].status, 'cancelled');
  assert.equal(sends, 0);
});

test('open pixel records only an open signal, never a human read', async () => {
  const { service, createCampaign } = setup();
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  service.scheduleCampaign(human, campaign.id);
  await service.dispatchDue({ ...human, actorType: 'worker', permissions: ['campaign.worker'] });
  const token = [...service.store.trackingTokens.entries()].find(([, item]) => item.type === 'open')[0];
  service.recordOpen(token);
  const report = service.getCampaignReport(human, campaign.id);
  assert.equal(report.signals.open_signal.count, 1);
  assert.equal(report.humanReadClaim, false);
  assert.match(report.signals.open_signal.interpretation, /not proof/);
});

test('tracking HTTP endpoints observe pixel/click requests and require POST to unsubscribe', async () => {
  const { service, createCampaign } = setup();
  const campaign = createCampaign();
  service.approveCampaign(human, campaign.id);
  service.scheduleCampaign(human, campaign.id);
  await service.dispatchDue({ ...human, actorType: 'worker', permissions: ['campaign.worker'] });
  const openToken = [...service.store.trackingTokens.entries()].find(([, item]) => item.type === 'open')[0];
  const clickToken = [...service.store.trackingTokens.entries()].find(([, item]) => item.type === 'click')[0];
  const unsubscribeToken = [...service.store.trackingTokens.entries()].find(([, item]) => item.type === 'unsubscribe')[0];

  await withServer({ service }, async (base) => {
    const pixel = await fetch(`${base}/v1/tracking/open/${openToken}.gif`);
    assert.equal(pixel.status, 200);
    assert.equal(pixel.headers.get('content-type'), 'image/gif');
    const click = await fetch(`${base}/v1/tracking/click/${clickToken}`, { redirect: 'manual' });
    assert.equal(click.status, 302);
    assert.equal(click.headers.get('location'), 'https://example.com/offer');
    const preview = await fetch(`${base}/v1/tracking/unsubscribe/${unsubscribeToken}`);
    assert.equal(preview.status, 200);
    assert.equal(service.store.suppressions.has(JSON.stringify(['tenant-a', 'business-a']) + ':contact-1'), false);
    const result = await fetch(`${base}/v1/tracking/unsubscribe/${unsubscribeToken}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
    });
    assert.equal(result.status, 200);
    assert.equal(service.store.suppressions.get(JSON.stringify(['tenant-a', 'business-a']) + ':contact-1').reason, 'UNSUBSCRIBED');
  });
});

test('reply, hard bounce, and unsubscribe halt follow-up workflows', async () => {
  for (const signal of ['reply', 'bounce', 'unsubscribe']) {
    const { service } = setup();
    const workflow = service.createFollowUpWorkflow(human, { recipientId: 'contact-1', plan: [{ kind: 'draft', delayHours: 24 }] });
    if (signal === 'reply') service.recordReply(human, 'contact-1');
    if (signal === 'bounce') service.recordHardBounce(human, 'contact-1');
    if (signal === 'unsubscribe') {
      const campaign = service.createCampaignDraft(human, { name: 'Unsub', templateId: 'welcome', templateVersion: 1, recipientIds: ['contact-1'] });
      service.approveCampaign(human, campaign.id);
      service.scheduleCampaign(human, campaign.id);
      await service.dispatchDue({ ...human, actorType: 'worker', permissions: ['campaign.worker'] });
      const token = [...service.store.trackingTokens.entries()].find(([, item]) => item.type === 'unsubscribe')[0];
      service.unsubscribe(token);
    }
    assert.equal(service.store.automations.get(workflow.id).status, 'paused');
  }
});

test('REST and MCP share trusted request authorization and campaign permission rules', async () => {
  const { service, createCampaign } = setup();
  const campaign = createCampaign();
  const authorizer = async (request) => {
    if (request.headers.authorization === 'Bearer trusted') return human;
    if (request.headers.authorization === 'Bearer other') return otherBusiness;
    if (request.headers.authorization === 'Bearer limited') return { ...human, permissions: ['campaign.write'] };
    return null;
  };
  await withServer({ service, authorizeRequest: authorizer }, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).gmail, 'adapter_injected');

    const denied = await fetch(`${base}/v1/campaigns/${campaign.id}/report`);
    assert.equal(denied.status, 401);
    const rest = await fetch(`${base}/v1/campaigns/${campaign.id}/report`, { headers: { authorization: 'Bearer trusted' } });
    assert.equal(rest.status, 200);
    const crossTenant = await fetch(`${base}/v1/campaigns/${campaign.id}/report`, { headers: { authorization: 'Bearer other' } });
    assert.equal(crossTenant.status, 404);
    const restPermission = await fetch(`${base}/v1/campaigns/${campaign.id}/report`, { headers: { authorization: 'Bearer limited' } });
    assert.equal(restPermission.status, 403);

    const mcpDenied = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(mcpDenied.status, 401);
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer trusted' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(mcp.status, 200);
    const names = (await mcp.json()).result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['create_campaign_draft', 'preview_campaign', 'schedule_approved_campaign', 'pause_campaign', 'get_campaign_report']);
    const initialized = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer trusted' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) });
    assert.equal((await initialized.json()).result.protocolVersion, '2024-11-05');
    const mcpSchedule = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer trusted' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'schedule_approved_campaign', arguments: { campaignId: campaign.id } } }) });
    assert.equal(JSON.parse((await mcpSchedule.json()).result.content[0].text).code, 'APPROVAL_REQUIRED');
    const mcpPermission = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer limited' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_campaign_report', arguments: { campaignId: campaign.id } } }) });
    const deniedTool = await mcpPermission.json();
    assert.equal(deniedTool.result.isError, true);
    assert.equal(JSON.parse(deniedTool.result.content[0].text).code, 'FORBIDDEN');
  });
});

test('Gmail adapter targets users.messages.send and reports request timeouts as ambiguous', async () => {
  let request;
  const adapter = createGmailApiAdapter({
    getAccessToken: async ({ tenantId, businessId }) => `${tenantId}:${businessId}:token`,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ id: 'gmail-message-id' }) };
    },
  });
  const sent = await adapter.send({ tenantId: 'tenant-a', businessId: 'business-a', message: { to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', plainText: 'Hi', unsubscribeUrl: 'https://example.com/u/token' } });
  assert.equal(sent.accepted, true);
  assert.equal(request.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  const packet = JSON.parse(request.options.body);
  assert.match(Buffer.from(packet.raw, 'base64url').toString('utf8'), /List-Unsubscribe-Post/);

  const timeout = createGmailApiAdapter({ getAccessToken: async () => 'injected-token', fetchImpl: async () => { throw new Error('socket timeout'); } });
  await assert.rejects(timeout.send({ tenantId: 't', businessId: 'b', message: { to: 'a@example.com', subject: 'Hi', html: '<p/>', plainText: 'Hi', unsubscribeUrl: 'https://example.com/u/t' } }), { code: 'GMAIL_SEND_UNKNOWN', safeToRetry: false });
});
