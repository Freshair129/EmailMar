import { randomUUID } from 'node:crypto';
import { fail, notFound, requireContext, requirePermission } from './errors.mjs';

const ALLOWED_KINDS = new Set(['draft', 'subject', 'segmentation_suggestion', 'followup_plan', 'review', 'human_gate']);
const copy = (value) => structuredClone(value);
const scopedRunId = (context, runId) => JSON.stringify([context.tenantId, context.businessId, runId]);

function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'Clock returned an invalid date.', 500);
  return date.toISOString();
}

function assertJsonValue(value, label) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text) > 100_000) throw new Error('invalid size');
    return JSON.parse(text);
  } catch {
    fail('INVALID_DAG_INPUT', `${label} must be JSON data no larger than 100 KB.`);
  }
}

function validateGraph(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 100) fail('INVALID_DAG', 'A run must contain between 1 and 100 nodes.');
  const byId = new Map();
  for (const item of nodes) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item.id)) fail('INVALID_DAG', 'Every node needs a valid unique id.');
    if (byId.has(item.id)) fail('INVALID_DAG', `Node id ${item.id} is duplicated.`);
    if (!ALLOWED_KINDS.has(item.kind)) fail('INVALID_DAG', `Node kind ${String(item.kind)} is not allowed.`);
    const dependsOn = item.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string') || new Set(dependsOn).size !== dependsOn.length) {
      fail('INVALID_DAG', `Dependencies for node ${item.id} must be unique node ids.`);
    }
    byId.set(item.id, item);
  }
  for (const item of nodes) {
    for (const dependency of item.dependsOn ?? []) {
      if (!byId.has(dependency) || dependency === item.id) fail('INVALID_DAG', `Node ${item.id} has an unknown or self dependency.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail('DAG_CYCLE', 'Execution DAG dependencies must be acyclic.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return byId;
}

function nodeView(node, includeFencingToken = false) {
  const { claimToken, ...view } = node;
  return { ...copy(view), ...(includeFencingToken && claimToken ? { fencingToken: claimToken } : {}) };
}

function runView(run) {
  return { ...copy({ ...run, nodes: undefined }), nodes: run.nodes.map((node) => nodeView(node)) };
}

export class ExecutionDagService {
  constructor({ store, clock = () => new Date(), idFactory = randomUUID } = {}) {
    if (!store?.dagRuns || typeof store.checkpoint !== 'function') throw new TypeError('ExecutionDagService requires a store with dagRuns and checkpoint().');
    this.store = store;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  #assertHealthy() {
    this.store.assertHealthy?.();
  }

  #audit(context, action, run, node, details = {}) {
    this.store.audit.push({
      id: this.idFactory(), tenantId: context.tenantId, businessId: context.businessId,
      actorId: context.actorId, action, subjectType: node ? 'dag_node' : 'dag_run',
      subjectId: String(node?.id ?? run.id).slice(0, 160), at: isoNow(this.clock),
      details: { runId: run.id, ...(node ? { kind: node.kind } : {}), ...copy(details) },
    });
    this.store.checkpoint();
  }

  #getRun(context, runId) {
    const run = this.store.dagRuns.get(scopedRunId(context, runId));
    if (!run) notFound();
    return run;
  }

  #refreshRunStatus(run) {
    if (run.status === 'paused') return;
    if (run.nodes.every((node) => node.state === 'completed')) run.status = 'completed';
    else if (run.nodes.every((node) => ['completed', 'stopped'].includes(node.state)) && run.nodes.some((node) => node.state === 'stopped')) run.status = 'stopped';
    else run.status = 'active';
  }

  #refreshReadyNodes(run) {
    for (const node of run.nodes) {
      if (node.state !== 'blocked') continue;
      const dependencies = node.dependsOn.map((id) => run.nodes.find((candidate) => candidate.id === id));
      if (dependencies.every((dependency) => dependency.state === 'completed')) node.state = 'ready';
      node.updatedAt = isoNow(this.clock);
    }
  }

  create(context, { id = this.idFactory(), nodes } = {}) {
    requirePermission(context, 'dag.write');
    this.#assertHealthy();
    if (typeof id !== 'string' || !id || id.length > 160) fail('INVALID_DAG', 'Run id must be non-empty text no longer than 160 characters.');
    const storageKey = scopedRunId(context, id);
    if (this.store.dagRuns.has(storageKey)) fail('DAG_RUN_EXISTS', 'Execution DAG run id already exists in this scope.', 409);
    const graph = validateGraph(nodes);
    const at = isoNow(this.clock);
    const run = {
      id, tenantId: context.tenantId, businessId: context.businessId, createdBy: context.actorId,
      status: 'active', pauseReason: null, createdAt: at, updatedAt: at,
      nodes: [...graph.values()].map((item) => ({
        id: item.id,
        kind: item.kind,
        dependsOn: [...(item.dependsOn ?? [])],
        input: assertJsonValue(item.input ?? null, `Input for node ${item.id}`),
        state: (item.dependsOn ?? []).length ? 'blocked' : 'ready',
        result: null,
        claimGeneration: 0,
        claimToken: null,
        claimedBy: null,
        claimedAt: null,
        completedBy: null,
        completedAt: null,
        interruptedAt: null,
        updatedAt: at,
      })),
    };
    this.store.dagRuns.set(storageKey, run);
    this.#audit(context, 'dag.created', run, null, { nodeCount: run.nodes.length });
    return runView(run);
  }

  get(context, runId) {
    requirePermission(context, 'dag.read');
    this.#assertHealthy();
    return runView(this.#getRun(context, runId));
  }

  list(context) {
    requirePermission(context, 'dag.read');
    this.#assertHealthy();
    return [...this.store.dagRuns.values()]
      .filter((run) => run.tenantId === context.tenantId && run.businessId === context.businessId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(runView);
  }

  claim(context, runId, nodeId, { workerId = context?.actorId } = {}) {
    requirePermission(context, 'dag.worker');
    this.#assertHealthy();
    const run = this.#getRun(context, runId);
    const node = run.nodes.find((item) => item.id === nodeId);
    if (!node) notFound();
    if (node.kind === 'human_gate') fail('DAG_HUMAN_GATE_REQUIRED', 'Human gate nodes must be completed directly by an authorized human.', 409);
    if (run.status !== 'active') fail('DAG_RUN_NOT_ACTIVE', 'Execution DAG run is not active.', 409);
    if (node.state === 'interrupted') fail('DAG_NODE_INTERRUPTED', 'An interrupted node needs an explicit human resume before it can be claimed.', 409);
    if (node.state !== 'ready') fail('DAG_NODE_NOT_READY', 'Execution DAG node is not ready to claim.', 409);
    if (typeof workerId !== 'string' || !workerId || workerId.length > 160) fail('INVALID_WORKER', 'Worker id must be non-empty text no longer than 160 characters.');
    const at = isoNow(this.clock);
    node.state = 'running';
    node.claimGeneration += 1;
    node.claimToken = this.idFactory();
    node.claimedBy = workerId;
    node.claimedAt = at;
    node.updatedAt = at;
    run.updatedAt = at;
    this.#audit(context, 'dag.node_claimed', run, node, { claimGeneration: node.claimGeneration, workerId });
    return { runId: run.id, node: nodeView(node), fencingToken: node.claimToken };
  }

  complete(context, runId, nodeId, { fencingToken = null, result = null } = {}) {
    requireContext(context);
    this.#assertHealthy();
    const run = this.#getRun(context, runId);
    const node = run.nodes.find((item) => item.id === nodeId);
    if (!node) notFound();
    if (node.kind === 'human_gate') {
      requirePermission(context, 'dag.gate');
      if (context.actorType !== 'human') fail('HUMAN_GATE_REQUIRED', 'Only an authenticated human can complete a human gate.', 403);
      if (node.state !== 'ready') fail('DAG_NODE_NOT_READY', 'Human gate node is not ready for a decision.', 409);
      if (!result || !['pass', 'stop'].includes(result.decision)) fail('INVALID_GATE_DECISION', 'Human gate result must have decision pass or stop.');
    } else {
      requirePermission(context, 'dag.worker');
      if (node.state !== 'running' || !fencingToken || node.claimToken !== fencingToken) fail('DAG_FENCE_REJECTED', 'Node completion requires its current fencing token.', 409);
    }
    if (run.status !== 'active') fail('DAG_RUN_NOT_ACTIVE', 'Execution DAG run is not active.', 409);
    const safeResult = assertJsonValue(result, `Result for node ${node.id}`);
    if (node.kind === 'human_gate' && !['pass', 'stop'].includes(safeResult?.decision)) fail('INVALID_GATE_DECISION', 'Human gate result must have decision pass or stop.');
    const at = isoNow(this.clock);
    node.result = safeResult;
    const stoppedRun = node.kind === 'human_gate' && safeResult.decision === 'stop';
    node.state = stoppedRun ? 'stopped' : 'completed';
    node.completedBy = context.actorId;
    node.completedAt = at;
    node.updatedAt = at;
    node.claimToken = null;
    let fencedNodeIds = [];
    if (stoppedRun) {
      run.status = 'stopped';
      fencedNodeIds = run.nodes.filter((other) => other !== node && other.state !== 'completed' && other.state !== 'stopped').map((other) => other.id);
      for (const other of run.nodes) {
        if (other === node || other.state === 'completed' || other.state === 'stopped') continue;
        other.state = 'stopped';
        other.claimToken = null;
        other.stoppedAt = at;
        other.updatedAt = at;
      }
    } else {
      this.#refreshReadyNodes(run);
      this.#refreshRunStatus(run);
    }
    run.updatedAt = at;
    this.#audit(context, node.kind === 'human_gate' ? 'dag.gate_decided' : 'dag.node_completed', run, node, {
      ...(node.kind === 'human_gate' ? { decision: safeResult.decision } : {}),
      ...(stoppedRun ? { fencedNodeIds } : {}),
      claimGeneration: node.claimGeneration,
    });
    return runView(run);
  }

  pause(context, runId, reason) {
    requirePermission(context, 'dag.write');
    this.#assertHealthy();
    const run = this.#getRun(context, runId);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) fail('INVALID_DAG_PAUSE', 'Pause reason must be text no longer than 500 characters.');
    if (run.status === 'completed' || run.status === 'stopped') fail('DAG_RUN_TERMINAL', 'A terminal execution DAG run cannot be paused.', 409);
    const at = isoNow(this.clock);
    run.status = 'paused';
    run.pauseReason = reason.trim();
    run.updatedAt = at;
    for (const node of run.nodes) {
      if (node.state !== 'running') continue;
      node.state = 'interrupted';
      node.claimToken = null;
      node.interruptedAt = at;
      node.updatedAt = at;
    }
    this.#audit(context, 'dag.paused', run, null, { reason: run.pauseReason });
    return runView(run);
  }

  resume(context, runId) {
    requireContext(context);
    requirePermission(context, 'dag.gate');
    this.#assertHealthy();
    if (context.actorType !== 'human') fail('HUMAN_GATE_REQUIRED', 'Only an authenticated human can resume a paused execution DAG.', 403);
    const run = this.#getRun(context, runId);
    if (run.status !== 'paused') fail('DAG_RUN_NOT_PAUSED', 'Execution DAG run is not paused.', 409);
    run.status = 'active';
    run.pauseReason = null;
    run.updatedAt = isoNow(this.clock);
    this.#audit(context, 'dag.resumed', run, null, {});
    return runView(run);
  }

  resumeInterrupted(context, runId, nodeId) {
    requireContext(context);
    requirePermission(context, 'dag.gate');
    this.#assertHealthy();
    if (context.actorType !== 'human') fail('HUMAN_GATE_REQUIRED', 'Only an authenticated human can resume an interrupted node.', 403);
    const run = this.#getRun(context, runId);
    const node = run.nodes.find((item) => item.id === nodeId);
    if (!node) notFound();
    if (run.status === 'paused') fail('DAG_RUN_NOT_ACTIVE', 'Resume the paused run before resetting an interrupted node.', 409);
    if (node.state !== 'interrupted') fail('DAG_NODE_NOT_INTERRUPTED', 'Only an interrupted node can be explicitly resumed.', 409);
    if (run.status !== 'active') fail('DAG_RUN_NOT_ACTIVE', 'Execution DAG run is not active.', 409);
    const dependencies = node.dependsOn.map((id) => run.nodes.find((candidate) => candidate.id === id));
    if (!dependencies.every((dependency) => dependency.state === 'completed')) fail('DAG_DEPENDENCIES_INCOMPLETE', 'Interrupted node dependencies have not completed successfully.', 409);
    const at = isoNow(this.clock);
    node.state = 'ready';
    node.claimToken = null;
    node.claimedBy = null;
    node.claimedAt = null;
    node.interruptedAt = null;
    node.updatedAt = at;
    run.updatedAt = at;
    this.#audit(context, 'dag.node_resumed', run, node, { claimGeneration: node.claimGeneration });
    return runView(run);
  }
}
