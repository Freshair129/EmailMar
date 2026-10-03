import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionDagService } from '../src/domain/execution-dag.mjs';
import { SqliteStore } from '../src/domain/store.mjs';

const HUMAN = {
  tenantId: 'tenant-a', businessId: 'business-a', actorId: 'human-a', actorType: 'human',
  permissions: ['dag.read', 'dag.write', 'dag.worker', 'dag.gate'],
};
const WORKER = { ...HUMAN, actorId: 'worker-a', actorType: 'agent' };
const NOW = '2026-09-24T10:00:00.000Z';

function fixturePath() {
  const directory = mkdtempSync(join(tmpdir(), 'emar-dag-'));
  return { directory, path: join(directory, 'state.sqlite') };
}

function createDag(path) {
  const store = new SqliteStore({ path });
  return { store, dag: new ExecutionDagService({ store, clock: () => new Date(NOW) }) };
}

test('DAG claims allow independent work, enforce dependencies and human gates, and reject cycles', () => {
  const fixture = fixturePath();
  let { store, dag } = createDag(fixture.path);
  try {
    const run = dag.create(HUMAN, { id: 'run-a', nodes: [
      { id: 'draft', kind: 'draft', input: { brief: 'Fixture only' } },
      { id: 'segment', kind: 'segmentation_suggestion' },
      { id: 'subject', kind: 'subject', dependsOn: ['draft'] },
      { id: 'gate', kind: 'human_gate', dependsOn: ['draft'] },
      { id: 'review', kind: 'review', dependsOn: ['gate'] },
    ] });
    assert.equal(run.status, 'active');
    assert.throws(() => dag.get({ ...HUMAN, businessId: 'other-business' }, 'run-a'), { code: 'NOT_FOUND' });
    assert.throws(() => dag.create(HUMAN, { id: 'run-a', nodes: [{ id: 'duplicate', kind: 'draft' }] }), { code: 'DAG_RUN_EXISTS' });
    const otherScope = { ...HUMAN, tenantId: 'tenant-b', businessId: 'business-b', actorId: 'human-b' };
    const samePublicId = dag.create(otherScope, { id: 'run-a', nodes: [{ id: 'other-draft', kind: 'draft' }] });
    assert.equal(samePublicId.id, 'run-a');
    assert.equal(samePublicId.tenantId, 'tenant-b');
    const privateRun = dag.create(HUMAN, { id: 'private-a', nodes: [{ id: 'private-node', kind: 'draft' }] });
    assert.equal(privateRun.id, 'private-a');
    assert.throws(() => dag.get(otherScope, 'private-a'), { code: 'NOT_FOUND' });
    assert.throws(() => dag.claim({ ...WORKER, tenantId: 'tenant-b', businessId: 'business-b' }, 'private-a', 'private-node'), { code: 'NOT_FOUND' });

    const draftClaim = dag.claim(WORKER, 'run-a', 'draft');
    const segmentClaim = dag.claim(WORKER, 'run-a', 'segment');
    assert.ok(draftClaim.fencingToken);
    assert.ok(segmentClaim.fencingToken);
    assert.throws(() => dag.claim(WORKER, 'run-a', 'draft'), { code: 'DAG_NODE_NOT_READY' });
    assert.throws(() => dag.complete(WORKER, 'run-a', 'draft', { fencingToken: 'stale-token', result: { text: 'ignored' } }), { code: 'DAG_FENCE_REJECTED' });

    dag.complete(WORKER, 'run-a', 'draft', { fencingToken: draftClaim.fencingToken, result: { draft: 'fixture' } });
    const current = dag.get(HUMAN, 'run-a');
    assert.equal(current.nodes.find((node) => node.id === 'subject').state, 'ready');
    assert.equal(current.nodes.find((node) => node.id === 'gate').state, 'ready');
    assert.equal(current.nodes.find((node) => node.id === 'review').state, 'blocked');
    assert.equal('claimToken' in current.nodes.find((node) => node.id === 'segment'), false);

    dag.complete(WORKER, 'run-a', 'segment', { fencingToken: segmentClaim.fencingToken, result: { suggestion: 'fixture' } });
    assert.throws(() => dag.claim(WORKER, 'run-a', 'gate'), { code: 'DAG_HUMAN_GATE_REQUIRED' });
    const nonHumanWithGatePermission = { ...WORKER, permissions: ['dag.gate'] };
    assert.throws(() => dag.complete(nonHumanWithGatePermission, 'run-a', 'gate', { result: { decision: 'pass' } }), { code: 'HUMAN_GATE_REQUIRED' });
    dag.complete(HUMAN, 'run-a', 'gate', { result: { decision: 'pass', note: 'reviewed' } });
    assert.equal(dag.get(HUMAN, 'run-a').nodes.find((node) => node.id === 'review').state, 'ready');

    const subjectClaim = dag.claim(WORKER, 'run-a', 'subject');
    const reviewClaim = dag.claim(WORKER, 'run-a', 'review');
    dag.complete(WORKER, 'run-a', 'subject', { fencingToken: subjectClaim.fencingToken, result: { subject: 'Hello' } });
    const completed = dag.complete(WORKER, 'run-a', 'review', { fencingToken: reviewClaim.fencingToken, result: { reviewed: true } });
    assert.equal(completed.status, 'completed');
    assert.ok(completed.nodes.every((node) => node.state === 'completed'));
    assert.throws(() => dag.complete(WORKER, 'run-a', 'review', { fencingToken: reviewClaim.fencingToken, result: {} }), { code: 'DAG_FENCE_REJECTED' });
    assert.throws(() => dag.create(HUMAN, { nodes: [
      { id: 'a', kind: 'draft', dependsOn: ['b'] }, { id: 'b', kind: 'review', dependsOn: ['a'] },
    ] }), { code: 'DAG_CYCLE' });
  } finally {
    try { store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('restart interrupts active DAG claims and requires human resume before a new fence', () => {
  const fixture = fixturePath();
  let { store, dag } = createDag(fixture.path);
  try {
    dag.create(HUMAN, { id: 'restart-run', nodes: [{ id: 'review', kind: 'review' }] });
    const firstClaim = dag.claim(WORKER, 'restart-run', 'review');
    store.close();

    ({ store, dag } = createDag(fixture.path));
    assert.equal(dag.get(HUMAN, 'restart-run').nodes[0].state, 'interrupted');
    assert.ok(store.audit.some((event) => event.action === 'dag.node_interrupted'));
    assert.throws(() => dag.claim(WORKER, 'restart-run', 'review'), { code: 'DAG_NODE_INTERRUPTED' });
    assert.throws(() => dag.resumeInterrupted(WORKER, 'restart-run', 'review'), { code: 'HUMAN_GATE_REQUIRED' });
    dag.resumeInterrupted(HUMAN, 'restart-run', 'review');
    const resumedClaim = dag.claim(WORKER, 'restart-run', 'review');
    assert.notEqual(resumedClaim.fencingToken, firstClaim.fencingToken);
    assert.equal(resumedClaim.node.claimGeneration, 2);
    assert.throws(() => dag.complete(WORKER, 'restart-run', 'review', { fencingToken: firstClaim.fencingToken, result: {} }), { code: 'DAG_FENCE_REJECTED' });
    assert.equal(dag.complete(WORKER, 'restart-run', 'review', { fencingToken: resumedClaim.fencingToken, result: { reviewed: true } }).status, 'completed');
  } finally {
    try { store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a human stop decision terminates the DAG and fences independent active nodes', () => {
  const fixture = fixturePath();
  let { store, dag } = createDag(fixture.path);
  try {
    dag.create(HUMAN, { id: 'stop-run', nodes: [
      { id: 'gate', kind: 'human_gate' },
      { id: 'active', kind: 'draft' },
      { id: 'dependent', kind: 'review', dependsOn: ['gate'] },
    ] });
    const activeClaim = dag.claim(WORKER, 'stop-run', 'active');
    const stopped = dag.complete(HUMAN, 'stop-run', 'gate', { result: { decision: 'stop', note: 'halt fixture' } });
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.nodes.find((node) => node.id === 'active').state, 'stopped');
    assert.equal(stopped.nodes.find((node) => node.id === 'dependent').state, 'stopped');
    assert.throws(() => dag.complete(WORKER, 'stop-run', 'active', { fencingToken: activeClaim.fencingToken, result: {} }), { code: 'DAG_FENCE_REJECTED' });
    assert.throws(() => dag.claim(WORKER, 'stop-run', 'active'), { code: 'DAG_RUN_NOT_ACTIVE' });
  } finally {
    try { store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('pausing a run interrupts claims and only a human can resume it', () => {
  const fixture = fixturePath();
  let { store, dag } = createDag(fixture.path);
  try {
    dag.create(HUMAN, { id: 'pause-run', nodes: [{ id: 'draft', kind: 'draft' }] });
    dag.claim(WORKER, 'pause-run', 'draft');
    assert.equal(dag.pause(HUMAN, 'pause-run', 'operator requested pause').status, 'paused');
    assert.throws(() => dag.resume(WORKER, 'pause-run'), { code: 'HUMAN_GATE_REQUIRED' });
    dag.resume(HUMAN, 'pause-run');
    assert.equal(dag.get(HUMAN, 'pause-run').status, 'active');
    assert.equal(dag.get(HUMAN, 'pause-run').nodes[0].state, 'interrupted');
    dag.resumeInterrupted(HUMAN, 'pause-run', 'draft');
    assert.equal(dag.get(HUMAN, 'pause-run').nodes[0].state, 'ready');
  } finally {
    try { store.close(); } catch { /* keep fixture cleanup deterministic */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
