import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi } from '../src/ui/demo.mjs';

const request = (api, path, body, method) => api.request(path, body, method);
const code = async (promise, expected) => {
  await assert.rejects(promise, (error) => error.code === expected);
};

test('demo returns UI-compatible isolated workspace data without using fetch', async () => {
  const api = createDemoApi();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('demo must not call fetch'); };
  try {
    const workspace = await request(api, '/v1/workspace');
    assert.equal(workspace.mode, 'demo');
    assert.equal(workspace.health.persistence, 'demo');
    assert.ok(workspace.recipients.some((recipient) => recipient.eligible));
    assert.ok(workspace.recipients.some((recipient) => recipient.reason === 'MARKETING_CONSENT_NOT_GRANTED'));
    assert.ok(workspace.recipients.some((recipient) => recipient.suppression?.reason === 'MANUAL_SUPPRESSION'));
    assert.ok(workspace.templates.length >= 2);
    assert.ok(workspace.attachments[0].fileRef.startsWith('demo://'));
    assert.ok(workspace.campaigns.every((campaign) => typeof campaign.name === 'string' && campaign.name.length > 0));
    assert.ok(workspace.campaigns.every((campaign) => campaign.report.humanReadClaim === false));

    workspace.recipients[0].displayName = 'tampered';
    workspace.campaigns.find((campaign) => campaign.id === 'campaign-songkran').report.queue.push({ status: 'accepted_by_gmail' });
    const fresh = await request(api, '/v1/workspace');
    assert.notEqual(fresh.recipients[0].displayName, 'tampered');
    assert.equal(fresh.campaigns.find((campaign) => campaign.id === 'campaign-songkran').report.queue.length, 0);
    assert.equal((await request(api, '/v1/integrations/gmail/status')).status, 'CONNECTED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unknown routes fail closed instead of falling through to network', async () => {
  const api = createDemoApi();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('unexpected network call'); };
  try {
    await code(request(api, '/v1/not-a-real-route'), 'NOT_FOUND');
    await code(request(api, '/v1/campaigns/campaign-workshop/dispatch/extra', {}, 'POST'), 'NOT_FOUND');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('editing an approved campaign invalidates its approval and schedule requires a fresh one', async () => {
  const api = createDemoApi();
  const campaignId = 'campaign-community';
  const current = await request(api, `/v1/campaigns/${campaignId}`);
  const approved = await request(api, `/v1/campaigns/${campaignId}/approve`, { draftHash: (await request(api, `/v1/campaigns/${campaignId}/preview`, {}, 'POST')).draftHash }, 'POST');
  assert.equal(approved.status, 'approved');

  const edited = await request(api, `/v1/campaigns/${campaignId}`, {
    ...current.draft, name: `${current.draft.name} · แก้ไข`,
  }, 'PATCH');
  assert.equal(edited.status, 'draft');
  assert.equal(edited.approval, null);
  await code(request(api, `/v1/campaigns/${campaignId}/schedule`, {}, 'POST'), 'APPROVAL_REQUIRED');

  const newPreview = await request(api, `/v1/campaigns/${campaignId}/preview`, {}, 'POST');
  await request(api, `/v1/campaigns/${campaignId}/approve`, { draftHash: newPreview.draftHash }, 'POST');
  const first = await request(api, `/v1/campaigns/${campaignId}/schedule`, {}, 'POST');
  const second = await request(api, `/v1/campaigns/${campaignId}/schedule`, {}, 'POST');
  assert.equal(first.queued, 2);
  assert.deepEqual(second.queueIds, first.queueIds);
});

test('scheduling filters consent and suppression, and dispatch rechecks consent before simulated send', async () => {
  const api = createDemoApi();
  const campaignId = 'campaign-songkran';
  const preview = await request(api, `/v1/campaigns/${campaignId}/preview`, {}, 'POST');
  assert.equal(preview.recipients.total, 4);
  assert.equal(preview.recipients.eligible, 2);
  await request(api, `/v1/campaigns/${campaignId}/approve`, { draftHash: preview.draftHash }, 'POST');
  const queued = await request(api, `/v1/campaigns/${campaignId}/schedule`, {}, 'POST');
  assert.equal(queued.queued, 2);
  assert.equal(queued.withheld.length, 2);

  await request(api, '/v1/recipients/recipient-dao/suppression', { reason: 'MANUAL_SUPPRESSION' }, 'POST');
  const dispatched = await request(api, `/v1/campaigns/${campaignId}/dispatch`, {}, 'POST');
  assert.equal(dispatched.considered, 2);
  assert.equal(dispatched.outcomes.find((entry) => entry.reason === 'MANUAL_SUPPRESSION')?.status, 'cancelled');
  assert.ok(dispatched.outcomes.some((entry) => entry.status === 'accepted_by_gmail'));

  const report = await request(api, `/v1/campaigns/${campaignId}/report`, undefined, 'GET');
  assert.equal(report.queue.filter((entry) => entry.status === 'cancelled').length, 1);
  assert.equal(report.queue.filter((entry) => entry.status === 'accepted_by_gmail').length, 1);
});

test('demo dispatch demonstrates SEND_UNKNOWN once and never retries it', async () => {
  const api = createDemoApi();
  await request(api, '/v1/integrations/gmail/disconnect', {}, 'POST');
  await code(request(api, '/v1/campaigns/campaign-workshop/dispatch', {}, 'POST'), 'GMAIL_NOT_CONNECTED');
  const stillPending = await request(api, '/v1/campaigns/campaign-workshop/report', undefined, 'GET');
  assert.equal(stillPending.queue.filter((entry) => entry.status === 'pending').length, 2);

  await request(api, '/v1/integrations/gmail/connect', {}, 'POST');
  const first = await request(api, '/v1/campaigns/campaign-workshop/dispatch', {}, 'POST');
  assert.equal(first.simulation, 'demo-only');
  assert.equal(first.considered, 2);
  assert.ok(first.outcomes.some((entry) => entry.status === 'SEND_UNKNOWN' && entry.quotaConsumed));
  const second = await request(api, '/v1/campaigns/campaign-workshop/dispatch', {}, 'POST');
  assert.equal(second.considered, 0);
  const report = await request(api, '/v1/campaigns/campaign-workshop/report', undefined, 'GET');
  assert.equal(report.queue.filter((entry) => entry.status === 'SEND_UNKNOWN').length, 1);
  assert.equal(report.signals.delivery_unknown, 1);
});

test('demo tracking signals are marked as simulations and unsubscribe blocks future scheduling', async () => {
  const api = createDemoApi();
  const open = await request(api, '/v1/demo/signals', { campaignId: 'campaign-songkran', type: 'open_signal', recipientId: 'recipient-dao' }, 'POST');
  assert.equal(open.recorded, true);
  assert.match(open.interpretation, /not proof/i);
  await request(api, '/v1/demo/signals', { campaignId: 'campaign-songkran', type: 'unsubscribed', recipientId: 'recipient-dao' }, 'POST');
  const workspace = await request(api, '/v1/workspace');
  assert.equal(workspace.recipients.find((entry) => entry.id === 'recipient-dao').suppression.reason, 'UNSUBSCRIBED');
  await code(request(api, '/v1/demo/signals', { campaignId: 'campaign-songkran', type: 'sent' }, 'POST'), 'INVALID_SIGNAL');
});

test('DAG advancement runs parallel claim waves and stops at the explicit human gate', async () => {
  const api = createDemoApi();
  const first = await request(api, '/v1/demo/advance', {}, 'POST');
  assert.deepEqual(first.advanced.map((node) => node.state), ['running', 'running']);
  assert.equal(first.advanced.length, 2);
  const run = first.runs.find((entry) => entry.id === 'workflow-campaign-prep');
  assert.equal(run.nodes.filter((node) => node.state === 'running').length, 2);

  const second = await request(api, '/v1/demo/advance', {}, 'POST');
  assert.deepEqual(second.advanced.map((node) => node.state), ['completed', 'completed']);
  const third = await request(api, '/v1/demo/advance', {}, 'POST');
  assert.equal(third.advanced[0].kind, 'review');
  const fourth = await request(api, '/v1/demo/advance', {}, 'POST');
  assert.equal(fourth.waitingAtHumanGates.length, 1);
  assert.equal(fourth.waitingAtHumanGates[0].kind, 'human_gate');
  const gatePath = `/v1/dags/${fourth.waitingAtHumanGates[0].runId}/nodes/${fourth.waitingAtHumanGates[0].nodeId}/gate`;
  const gated = await request(api, gatePath, { decision: 'pass' }, 'POST');
  assert.equal(gated.status, 'completed');
  assert.equal(gated.nodes.at(-1).state, 'completed');
  assert.equal((await request(api, '/v1/workspace')).campaigns.find((item) => item.id === 'campaign-songkran').status, 'draft');
});

test('DAG pause interrupts running nodes and recovery requires an explicit human action', async () => {
  const api = createDemoApi();
  await request(api, '/v1/demo/advance', {}, 'POST');
  const paused = await request(api, '/v1/dags/workflow-campaign-prep/pause', { reason: 'ตรวจสอบก่อนดำเนินการ' }, 'POST');
  assert.equal(paused.nodes.filter((node) => node.state === 'interrupted').length, 2);
  await request(api, '/v1/dags/workflow-campaign-prep/resume', {}, 'POST');
  const recovered = await request(api, '/v1/dags/workflow-campaign-prep/nodes/draft-brief/recover', {}, 'POST');
  assert.equal(recovered.nodes.find((node) => node.id === 'draft-brief').state, 'ready');
  assert.equal(recovered.nodes.find((node) => node.id === 'suggest-subject').state, 'interrupted');
});

test('DAG worker claims return a fencing token without exposing internal claim state', async () => {
  const api = createDemoApi();
  await request(api, '/v1/dags', { id: 'worker-run', nodes: [{ id: 'draft', kind: 'draft' }, { id: 'gate', kind: 'human_gate', dependsOn: ['draft'] }] }, 'POST');
  const claim = await request(api, '/v1/dags/worker-run/nodes/draft/claim', { workerId: 'demo-reviewer' }, 'POST');
  assert.equal(claim.node.state, 'running');
  assert.ok(claim.fencingToken);
  assert.equal(Object.hasOwn(claim.node, 'claimToken'), false);
  assert.equal(Object.hasOwn((await request(api, '/v1/dags/worker-run', undefined, 'GET')).nodes[0], 'claimToken'), false);
  await code(request(api, '/v1/dags/worker-run/nodes/draft/complete', { fencingToken: 'stale', result: { draft: true } }, 'POST'), 'DAG_FENCE_REJECTED');
  const completed = await request(api, '/v1/dags/worker-run/nodes/draft/complete', { fencingToken: claim.fencingToken, result: { draft: true } }, 'POST');
  assert.equal(completed.nodes.find((node) => node.id === 'gate').state, 'ready');
});

test('DAG creation rejects cycles and a stop human gate terminates the run', async () => {
  const api = createDemoApi();
  await assert.rejects(request(api, '/v1/dags', { id: 'cycle', nodes: [
    { id: 'a', kind: 'draft', dependsOn: ['b'] }, { id: 'b', kind: 'review', dependsOn: ['a'] },
  ] }, 'POST'), (error) => error.code === 'DAG_CYCLE');

  await request(api, '/v1/dags', { id: 'stop-run', nodes: [{ id: 'gate', kind: 'human_gate' }, { id: 'work', kind: 'draft' }] }, 'POST');
  const stopped = await request(api, '/v1/dags/stop-run/nodes/gate/gate', { decision: 'stop' }, 'POST');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.nodes.find((node) => node.id === 'work').state, 'stopped');
});
