const DEMO_SCOPE = { tenantId: 'tenant-demo', businessId: 'business-demo' };
const DEMO_SENDER = { connectionId: 'demo-gmail-connection', accountId: 'demo-gmail-account', email: 'demo-sender@example.test' };
const ALLOWED_DAG_KINDS = new Set(['draft', 'subject', 'segmentation_suggestion', 'followup_plan', 'review', 'human_gate']);
const WORKER_KINDS = new Set(['draft', 'subject', 'segmentation_suggestion', 'followup_plan', 'review']);
const COPY = (value) => structuredClone(value);

function makeError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function demoHash(value) {
  // This is only a stable preview token for browser simulation; it is not a security hash.
  let hash = 2166136261;
  for (const character of stableJson(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `demo-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function eligibleFor(recipient, approvedEmail = recipient.email) {
  if (recipient.suppression) return { eligible: false, reason: recipient.suppression.reason };
  if (!recipient.consents.some((entry) => entry.type === 'EMAIL_MARKETING' && entry.status === 'GRANTED')) {
    return { eligible: false, reason: 'MARKETING_CONSENT_NOT_GRANTED' };
  }
  if (recipient.email !== approvedEmail) return { eligible: false, reason: 'RECIPIENT_ADDRESS_CHANGED_REAPPROVAL_REQUIRED' };
  return { eligible: true, reason: null };
}

function seedState() {
  let idCounter = 0;
  const newId = (prefix = 'demo') => `${prefix}-${String(++idCounter).padStart(4, '0')}`;
  const at = nowIso();
  const consent = (status) => [{ type: 'EMAIL_MARKETING', status, observedAt: at }];
  const recipients = [
    { id: 'recipient-dao', email: 'dao@example.test', displayName: 'ดาว', consents: consent('GRANTED'), suppression: null },
    { id: 'recipient-pim', email: 'pim@example.test', displayName: 'พิม', consents: consent('GRANTED'), suppression: null },
    { id: 'recipient-arn', email: 'arn@example.test', displayName: 'อาร์ณ', consents: consent('REVOKED'), suppression: null },
    { id: 'recipient-mali', email: 'mali@example.test', displayName: 'มะลิ', consents: consent('GRANTED'), suppression: { recipientId: 'recipient-mali', reason: 'MANUAL_SUPPRESSION', source: 'DEMO', createdAt: at } },
  ];
  const templates = [
    {
      id: 'template-songkran', version: 1,
      subject: 'สุขสันต์วันสงกรานต์ คุณ{{name}}',
      html: '<div style="font-family:Tahoma,sans-serif;line-height:1.8"><h2>สวัสดีคุณ {{name}}</h2><p>ขอบคุณที่เป็นส่วนหนึ่งของชุมชนเราในปีนี้</p><p>พบกันใหม่ในกิจกรรมถัดไปนะคะ</p></div>',
      plainText: 'สวัสดีคุณ {{name}}\n\nขอบคุณที่เป็นส่วนหนึ่งของชุมชนเราในปีนี้ พบกันใหม่ในกิจกรรมถัดไปนะคะ',
      variables: ['name'],
    },
    {
      id: 'template-workshop', version: 1,
      subject: 'เชิญร่วมเวิร์กช็อปชุมชน · {{month}}',
      html: '<div style="font-family:Tahoma,sans-serif;line-height:1.8"><h2>สวัสดีคุณ {{name}}</h2><p>ขอเชิญร่วมเวิร์กช็อปแบ่งปันไอเดียของชุมชนในเดือน {{month}}</p><p>ตัวอย่างนี้ไม่มีลิงก์ลงทะเบียนจริง</p></div>',
      plainText: 'สวัสดีคุณ {{name}}\n\nขอเชิญร่วมเวิร์กช็อปแบ่งปันไอเดียของชุมชนในเดือน {{month}}\nตัวอย่างนี้ไม่มีลิงก์ลงทะเบียนจริง',
      variables: ['name', 'month'],
    },
  ];
  const attachments = [{
    id: 'attachment-agenda', version: 1, filename: 'กำหนดการ-ตัวอย่าง.pdf',
    fileRef: 'demo://files/workshop-agenda.pdf', mimeType: 'application/pdf', size: 18432,
    sha256: 'a'.repeat(64),
  }];
  const campaigns = new Map();
  const campaignDraft = (name, templateId, recipientIds, recipientVariables, attachmentIds = []) => ({
    name, templateId, templateVersion: 1, recipientIds, recipientVariables, attachmentIds,
  });
  const draft = {
    id: 'campaign-songkran', tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId,
    createdBy: 'demo-operator', createdAt: at, updatedAt: at, status: 'draft', draftRevision: 1,
    draft: campaignDraft('ขอบคุณที่ร่วมแบ่งปันสุขสงกรานต์', 'template-songkran',
      ['recipient-dao', 'recipient-pim', 'recipient-arn', 'recipient-mali'], {
        'recipient-dao': { name: 'ดาว' }, 'recipient-pim': { name: 'พิม' },
        'recipient-arn': { name: 'อาร์ณ' }, 'recipient-mali': { name: 'มะลิ' },
      }),
    approval: null, approvals: [], queueIds: [], blockedRecipients: [], signals: [],
  };
  const approvedDraft = {
    id: 'campaign-community', tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId,
    createdBy: 'demo-operator', createdAt: at, updatedAt: at, status: 'approved', draftRevision: 1,
    draft: campaignDraft('ข่าวสารชุมชนประจำเดือน', 'template-workshop', ['recipient-dao', 'recipient-pim'], {
      'recipient-dao': { name: 'ดาว', month: 'เมษายน' }, 'recipient-pim': { name: 'พิม', month: 'เมษายน' },
    }),
    approval: null, approvals: [], queueIds: [], blockedRecipients: [], signals: [],
  };
  const scheduled = {
    id: 'campaign-workshop', tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId,
    createdBy: 'demo-operator', createdAt: at, updatedAt: at, status: 'scheduled', draftRevision: 1,
    draft: campaignDraft('เวิร์กช็อปแบ่งปันไอเดีย', 'template-workshop', ['recipient-dao', 'recipient-pim'], {
      'recipient-dao': { name: 'ดาว', month: 'เมษายน' }, 'recipient-pim': { name: 'พิม', month: 'เมษายน' },
    }, ['attachment-agenda']),
    approval: null, approvals: [], queueIds: [], blockedRecipients: [], signals: [],
  };
  const approvalSnapshot = (campaign) => {
    const template = templates.find((item) => item.id === campaign.draft.templateId && item.version === campaign.draft.templateVersion);
    return {
      campaignId: campaign.id, name: campaign.draft.name, template: COPY(template),
      recipients: campaign.draft.recipientIds.map((id) => {
        const recipient = recipients.find((item) => item.id === id);
        return { id, email: recipient.email, variables: COPY(campaign.draft.recipientVariables[id] ?? {}) };
      }),
      attachments: campaign.draft.attachmentIds.map((id) => COPY(attachments.find((item) => item.id === id))),
      senderIdentity: COPY(DEMO_SENDER),
    };
  };
  for (const campaign of [draft, approvedDraft, scheduled]) campaigns.set(campaign.id, campaign);
  for (const campaign of [approvedDraft, scheduled]) {
    const snapshot = approvalSnapshot(campaign);
    const approval = {
      payloadHash: demoHash(snapshot), snapshot, approvedBy: 'demo-operator', approvedAt: at,
    };
    campaign.approval = approval;
    campaign.approvals.push(approval);
  }
  const queue = new Map();
  const scheduleKeys = new Map();
  for (const [index, recipientId] of ['recipient-dao', 'recipient-pim'].entries()) {
    const campaign = scheduled;
    const recipient = recipients.find((item) => item.id === recipientId);
    const id = `queue-workshop-${index + 1}`;
    const key = `demo-key-${campaign.id}-${recipientId}`;
    const job = {
      id, key, campaignId: campaign.id, tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId,
      recipientId, approvedEmail: recipient.email, variables: COPY(campaign.draft.recipientVariables[recipientId]),
      approvalHash: campaign.approval.payloadHash, scheduledAt: at, day: at.slice(0, 10),
      status: 'pending', createdAt: at, startedAt: null, completedAt: null, errorCode: null,
      quotaConsumed: false, demoOutcome: index === 1 ? 'SEND_UNKNOWN' : 'accepted_by_gmail',
    };
    queue.set(key, job);
    campaign.queueIds.push(key);
  }
  scheduleKeys.set(`${scheduled.id}:${scheduled.approval.payloadHash}`, [...scheduled.queueIds]);
  const dailyUsage = new Map([[at.slice(0, 10), { reserved: 2, consumed: 0 }]]);
  const audit = [
    { id: 'audit-demo-seed', tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId, actorId: 'demo-operator', action: 'demo.seed_loaded', subjectType: 'workspace', subjectId: 'demo', at, details: { simulationOnly: true } },
  ];
  const dagRuns = new Map();
  const run = {
    id: 'workflow-campaign-prep', tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId,
    createdBy: 'demo-operator', status: 'active', pauseReason: null, createdAt: at, updatedAt: at,
    nodes: [
      ['draft-brief', 'draft', [], { label: 'ร่างโครงข้อความ', workflowLabel: 'เตรียมแคมเปญชุมชน' }],
      ['suggest-subject', 'subject', [], { label: 'เสนอหัวเรื่อง', workflowLabel: 'เตรียมแคมเปญชุมชน' }],
      ['review-plan', 'review', ['draft-brief', 'suggest-subject'], { label: 'ตรวจความครบถ้วน', workflowLabel: 'เตรียมแคมเปญชุมชน' }],
      ['human-gate', 'human_gate', ['review-plan'], { label: 'จุดตัดสินใจของผู้ดูแล', workflowLabel: 'เตรียมแคมเปญชุมชน' }],
    ].map(([id, kind, dependsOn, input]) => ({
      id, kind, dependsOn, input, state: dependsOn.length ? 'blocked' : 'ready', result: null,
      claimGeneration: 0, claimToken: null, claimedBy: null, claimedAt: null,
      completedBy: null, completedAt: null, interruptedAt: null, updatedAt: at,
    })),
  };
  dagRuns.set(JSON.stringify([run.tenantId, run.businessId, run.id]), run);
  return {
    idFactory: newId, recipients, templates, attachments, campaigns, queue, scheduleKeys,
    dailyUsage, audit, dagRuns, gmailStatus: { status: 'CONNECTED', email: DEMO_SENDER.email, scopes: ['gmail.send'], demo: true },
  };
}

function campaignCopy(campaign) {
  const { approvals, queueIds, blockedRecipients, signals, approval, ...publicCampaign } = campaign;
  return {
    ...COPY(publicCampaign),
    name: campaign.draft.name,
    approval: approval ? { payloadHash: approval.payloadHash, approvedAt: approval.approvedAt, approvedBy: approval.approvedBy } : null,
  };
}

function dagRunCopy(run) {
  const { nodes, ...rest } = run;
  return { ...COPY(rest), nodes: nodes.map(({ claimToken, ...node }) => COPY(node)) };
}

function validateDag(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 100) throw makeError('INVALID_DAG', 'A workflow needs between 1 and 100 steps.');
  const byId = new Map();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(node.id) || byId.has(node.id)) {
      throw makeError('INVALID_DAG', 'Workflow step ids must be unique valid names.');
    }
    if (!ALLOWED_DAG_KINDS.has(node.kind)) throw makeError('INVALID_DAG', 'This workflow step kind is not supported in demo mode.');
    const dependsOn = node.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string') || new Set(dependsOn).size !== dependsOn.length) {
      throw makeError('INVALID_DAG', 'Workflow dependencies must be unique step ids.');
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) for (const dependency of node.dependsOn ?? []) {
    if (!byId.has(dependency) || dependency === node.id) throw makeError('INVALID_DAG', 'Workflow dependency references an unknown or self step.');
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw makeError('DAG_CYCLE', 'Workflow dependencies must be acyclic.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return byId;
}

export function createDemoApi() {
  let state = seedState();

  function audit(action, subjectType, subjectId, details = {}) {
    state.audit.push({
      id: state.idFactory('audit'), tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId,
      actorId: 'demo-operator', action, subjectType, subjectId: String(subjectId).slice(0, 160),
      at: nowIso(), details: COPY(details),
    });
  }

  function recipient(id) {
    const found = state.recipients.find((item) => item.id === id);
    if (!found) throw makeError('RECIPIENT_NOT_FOUND', 'Recipient was not found in the demo workspace.', 404);
    return found;
  }

  function campaign(id) {
    const found = state.campaigns.get(id);
    if (!found) throw makeError('NOT_FOUND', 'Campaign was not found in the demo workspace.', 404);
    return found;
  }

  function template(id, version) {
    const found = state.templates.find((item) => item.id === id && item.version === Number(version));
    if (!found) throw makeError('TEMPLATE_NOT_FOUND', 'Template version was not found in the demo workspace.', 404);
    return found;
  }

  function snapshot(item) {
    return {
      campaignId: item.id, name: item.draft.name,
      template: COPY(template(item.draft.templateId, item.draft.templateVersion)),
      recipients: item.draft.recipientIds.map((id) => {
        const current = recipient(id);
        return { id, email: current.email, variables: COPY(item.draft.recipientVariables[id] ?? {}) };
      }),
      attachments: item.draft.attachmentIds.map((id) => {
        const attachment = state.attachments.find((entry) => entry.id === id);
        if (!attachment) throw makeError('ATTACHMENT_NOT_FOUND', 'Attachment was not found in the demo workspace.', 404);
        return COPY(attachment);
      }),
      senderIdentity: COPY(DEMO_SENDER),
    };
  }

  function preview(item, options = {}) {
    const current = snapshot(item);
    const draftHash = demoHash(current);
    if (options.draftHash && options.draftHash !== draftHash) throw makeError('DRAFT_CHANGED', 'Draft changed; refresh the preview before approving.', 409);
    const sampleId = options.recipientId ?? current.recipients[0]?.id;
    const sample = current.recipients.find((entry) => entry.id === sampleId);
    if (!sample) throw makeError('RECIPIENT_NOT_IN_CAMPAIGN', 'Preview recipient is not part of this campaign.');
    const eligible = current.recipients.map((entry) => ({ recipientId: entry.id, ...eligibleFor(recipient(entry.id), entry.email) }));
    const render = (text, html = false) => text.replace(/{{\s*([A-Za-z_][\w.-]*)\s*}}/g, (_match, name) => {
      const value = sample.variables[name] ?? '';
      return html ? String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) : String(value);
    });
    return {
      campaignId: item.id, draftRevision: item.draftRevision, draftHash,
      template: { id: current.template.id, version: current.template.version },
      recipients: { total: eligible.length, eligible: eligible.filter((entry) => entry.eligible).length, withheld: eligible.filter((entry) => !entry.eligible) },
      sample: { recipientId: sample.id, subject: render(current.template.subject), html: render(current.template.html, true), plainText: render(current.template.plainText) },
      tracking: { openSignalMeaning: 'Image request observed; this is not proof that a person read the email.', customJavaScript: false },
      simulation: 'demo-only',
    };
  }

  function report(item) {
    const jobs = item.queueIds.map((key) => state.queue.get(key)).filter(Boolean);
    const count = (type) => item.signals.filter((signal) => signal.type === type).length;
    return {
      campaignId: item.id, status: item.status,
      approval: item.approval ? { payloadHash: item.approval.payloadHash, approvedAt: item.approval.approvedAt, approvedBy: item.approval.approvedBy } : null,
      queue: jobs.map((job) => ({ id: job.id, recipientId: job.recipientId, status: job.status, scheduledAt: job.scheduledAt, completedAt: job.completedAt, errorCode: job.errorCode })),
      withheldRecipients: COPY(item.blockedRecipients),
      signals: {
        accepted_by_gmail: count('accepted_by_gmail'), delivery_unknown: count('delivery_unknown'),
        open_signal: { count: count('open_signal'), interpretation: 'An image request was observed; this does not prove a human read the email.' },
        click_observed: count('click_observed'), reply_received: count('reply_received'),
        bounce_detected: count('bounce_detected'), unsubscribed: count('unsubscribed'),
      },
      humanReadClaim: false, simulation: 'demo-only',
    };
  }

  function workspace() {
    const campaigns = [...state.campaigns.values()].map((item) => ({ ...campaignCopy(item), report: report(item) })).reverse();
    return {
      campaigns,
      recipients: state.recipients.map((item) => ({ ...COPY(item), ...eligibleFor(item), suppression: COPY(item.suppression) })),
      templates: COPY(state.templates), attachments: COPY(state.attachments),
      audit: COPY(state.audit.slice(-50).reverse()),
      health: { status: 'ok', service: 'emar', version: '0.3.0-beta.0', persistence: 'demo', gmail: 'demo', files: 'demo', dailyLimit: 500, authentication: 'demo-only', demo: true },
      scope: COPY(DEMO_SCOPE), mode: 'demo', simulation: 'demo-only',
    };
  }

  function schedule(item, requestedAt = null) {
    if (!['approved', 'scheduled'].includes(item.status) || !item.approval) throw makeError('APPROVAL_REQUIRED', 'A human-approved snapshot is required before scheduling.', 409);
    const current = snapshot(item);
    if (demoHash(current) !== item.approval.payloadHash) throw makeError('REAPPROVAL_REQUIRED', 'This draft changed after approval. Review and approve it again.', 409);
    const scheduledAt = requestedAt ?? nowIso();
    const date = new Date(scheduledAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() < nowIso()) throw makeError('INVALID_SCHEDULE', 'Schedule time must be now or later.');
    const key = `${item.id}:${item.approval.payloadHash}`;
    const previous = state.scheduleKeys.get(key);
    if (previous) return scheduleResult(item, previous);
    const ids = [];
    const withheld = [];
    for (const approvedRecipient of item.approval.snapshot.recipients) {
      const currentRecipient = recipient(approvedRecipient.id);
      const eligibility = eligibleFor(currentRecipient, approvedRecipient.email);
      if (!eligibility.eligible) {
        withheld.push({ recipientId: approvedRecipient.id, reason: eligibility.reason, at: date.toISOString() });
        continue;
      }
      const queueKey = `demo-key-${demoHash([item.id, item.approval.payloadHash, approvedRecipient.id])}`;
      if (!state.queue.has(queueKey)) state.queue.set(queueKey, {
        id: state.idFactory('queue'), key: queueKey, campaignId: item.id,
        tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId,
        recipientId: approvedRecipient.id, approvedEmail: approvedRecipient.email,
        variables: COPY(approvedRecipient.variables), approvalHash: item.approval.payloadHash,
        scheduledAt: date.toISOString(), day: date.toISOString().slice(0, 10), status: 'pending',
        createdAt: date.toISOString(), startedAt: null, completedAt: null, errorCode: null, quotaConsumed: false,
        demoOutcome: 'accepted_by_gmail',
      });
      ids.push(queueKey);
    }
    item.blockedRecipients.push(...withheld);
    item.queueIds = [...new Set([...item.queueIds, ...ids])];
    item.status = 'scheduled'; item.updatedAt = date.toISOString();
    state.scheduleKeys.set(key, ids);
    const usage = state.dailyUsage.get(date.toISOString().slice(0, 10)) ?? { reserved: 0, consumed: 0 };
    usage.reserved += ids.length;
    state.dailyUsage.set(date.toISOString().slice(0, 10), usage);
    audit('campaign.scheduled', 'campaign', item.id, { simulationOnly: true, scheduledCount: ids.length, withheldCount: withheld.length });
    return scheduleResult(item, ids);
  }

  function scheduleResult(item, keys) {
    return {
      campaignId: item.id, status: item.status, queued: keys.length,
      queueIds: keys.map((key) => state.queue.get(key)?.id).filter(Boolean),
      withheld: COPY(item.blockedRecipients), simulation: 'demo-only',
    };
  }

  function dispatch(item) {
    const pending = item.queueIds.map((key) => state.queue.get(key)).filter((job) => job?.status === 'pending' && job.scheduledAt <= nowIso());
    const outcomes = [];
    for (const job of pending) {
      const currentRecipient = recipient(job.recipientId);
      const eligibility = eligibleFor(currentRecipient, job.approvedEmail);
      if (!eligibility.eligible || item.status === 'paused' || !item.approval || item.approval.payloadHash !== job.approvalHash) {
        job.status = 'cancelled'; job.errorCode = eligibility.eligible ? 'CAMPAIGN_PAUSED_OR_APPROVAL_STALE' : eligibility.reason;
        job.completedAt = nowIso();
        const usage = state.dailyUsage.get(job.day);
        if (usage) usage.reserved = Math.max(0, usage.reserved - 1);
        item.blockedRecipients.push({ recipientId: job.recipientId, reason: job.errorCode, at: job.completedAt });
        audit('queue.withheld', 'queue_entry', job.id, { reason: job.errorCode, simulationOnly: true });
        outcomes.push({ queueId: job.id, status: job.status, reason: job.errorCode });
        continue;
      }
      job.status = 'sending'; job.startedAt = nowIso();
      const usage = state.dailyUsage.get(job.day) ?? { reserved: 0, consumed: 0 };
      usage.reserved = Math.max(0, usage.reserved - 1); usage.consumed += 1;
      state.dailyUsage.set(job.day, usage);
      job.quotaConsumed = true;
      if (job.demoOutcome === 'SEND_UNKNOWN') {
        job.status = 'SEND_UNKNOWN'; job.errorCode = 'DEMO_OUTCOME_UNKNOWN';
        appendSignal(item, job.recipientId, 'delivery_unknown', { queueId: job.id, simulationOnly: true });
      } else {
        job.status = 'accepted_by_gmail';
        appendSignal(item, job.recipientId, 'accepted_by_gmail', { queueId: job.id, simulationOnly: true });
      }
      job.completedAt = nowIso();
      audit(`queue.${job.status.toLowerCase()}`, 'queue_entry', job.id, { simulationOnly: true, quotaConsumed: true });
      outcomes.push({ queueId: job.id, status: job.status, quotaConsumed: true, simulation: 'demo-only' });
    }
    return { considered: pending.length, outcomes, simulation: 'demo-only', retryableUnknownCount: 0 };
  }

  function appendSignal(item, recipientId, type, details = {}) {
    const event = { type, recipientId, at: nowIso(), ...COPY(details) };
    item.signals.push(event);
    return event;
  }

  function setRecipient(input) {
    if (!input || typeof input.id !== 'string' || !input.id || typeof input.email !== 'string' || !input.email.includes('@')) throw makeError('INVALID_RECIPIENT', 'A recipient id and email address are required.');
    const prior = state.recipients.find((item) => item.id === input.id);
    const updated = {
      id: input.id, email: input.email, displayName: String(input.displayName ?? ''),
      consents: COPY(input.consents ?? []), suppression: COPY(prior?.suppression ?? null),
    };
    const index = state.recipients.findIndex((item) => item.id === input.id);
    if (index < 0) state.recipients.push(updated); else state.recipients[index] = updated;
    audit(prior ? 'recipient.projection_updated' : 'recipient.projection_created', 'recipient', input.id, { marketingConsent: updated.consents.some((entry) => entry.type === 'EMAIL_MARKETING' && entry.status === 'GRANTED'), simulationOnly: true });
    return COPY(updated);
  }

  function runById(id) {
    const run = state.dagRuns.get(JSON.stringify([DEMO_SCOPE.tenantId, DEMO_SCOPE.businessId, id]));
    if (!run) throw makeError('NOT_FOUND', 'Workflow was not found in the demo workspace.', 404);
    return run;
  }

  function refreshDag(run) {
    for (const node of run.nodes) {
      if (node.state !== 'blocked') continue;
      if (node.dependsOn.every((id) => run.nodes.find((candidate) => candidate.id === id)?.state === 'completed')) {
        node.state = 'ready';
        node.updatedAt = nowIso();
      }
    }
    if (run.status === 'paused' || run.status === 'stopped') return;
    if (run.nodes.every((node) => node.state === 'completed')) run.status = 'completed';
    else run.status = 'active';
    run.updatedAt = nowIso();
  }

  function advanceDag(runId = null) {
    const runs = [...state.dagRuns.values()].filter((run) => runId == null || run.id === runId);
    if (runId != null && !runs.length) throw makeError('NOT_FOUND', 'Workflow was not found in the demo workspace.', 404);
    const advanced = [];
    const waitingAtHumanGates = [];
    for (const run of runs) {
      if (run.status !== 'active') continue;
      const ready = run.nodes.filter((node) => node.state === 'ready');
      const running = run.nodes.filter((node) => node.state === 'running' && WORKER_KINDS.has(node.kind));
      if (running.length) {
        // Complete one previously claimed wave. No model or external worker runs here.
        for (const node of running) {
          node.state = 'completed'; node.result = { simulated: true, summary: `ตัวอย่างผลลัพธ์สำหรับ ${node.kind}` };
          node.completedBy = 'demo-simulator'; node.completedAt = nowIso(); node.updatedAt = node.completedAt;
          node.claimToken = null;
          advanced.push({ runId: run.id, nodeId: node.id, kind: node.kind, state: 'completed' });
          audit('dag.node_simulated', 'dag_node', node.id, { runId: run.id, kind: node.kind, simulationOnly: true });
        }
        refreshDag(run);
      } else {
        // Claim every ready worker in the same wave so pause/recover can be rehearsed.
        for (const node of ready) {
          if (node.kind === 'human_gate') continue;
          if (!WORKER_KINDS.has(node.kind)) continue;
          node.state = 'running'; node.claimGeneration += 1;
          node.claimToken = state.idFactory('fence'); node.claimedBy = 'demo-worker';
          node.claimedAt = nowIso(); node.updatedAt = node.claimedAt;
          advanced.push({ runId: run.id, nodeId: node.id, kind: node.kind, state: 'running' });
          audit('dag.node_claimed', 'dag_node', node.id, { runId: run.id, workerId: 'demo-worker', simulationOnly: true });
        }
      }
      run.updatedAt = nowIso();
      for (const node of run.nodes.filter((candidate) => candidate.state === 'ready' && candidate.kind === 'human_gate')) {
        const gate = { runId: run.id, nodeId: node.id, kind: node.kind, state: node.state };
        if (!waitingAtHumanGates.some((entry) => entry.runId === gate.runId && entry.nodeId === gate.nodeId)) waitingAtHumanGates.push(gate);
      }
    }
    return {
      simulation: 'demo-only', advanced, waitingAtHumanGates,
      runs: runs.map(dagRunCopy),
    };
  }

  async function request(path, body, method = 'GET') {
    if (typeof path !== 'string' || typeof method !== 'string') throw makeError('INVALID_REQUEST', 'Demo requests need a path and method.');
    const verb = method.toUpperCase();
    let pathname;
    try { pathname = new URL(path, 'http://demo.local').pathname; } catch { throw makeError('NOT_FOUND', 'Unknown demo route.', 404); }
    const parts = pathname.split('/').filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch { throw makeError('NOT_FOUND', 'Unknown demo route.', 404); }
    });
    if (verb === 'GET' && pathname === '/v1/workspace') return COPY(workspace());
    if (verb === 'GET' && pathname === '/v1/integrations/gmail/status') return COPY(state.gmailStatus);
    if (verb === 'POST' && pathname === '/v1/integrations/gmail/connect') {
      state.gmailStatus = { status: 'CONNECTED', email: DEMO_SENDER.email, scopes: ['gmail.send'], demo: true };
      audit('gmail.demo_connected', 'integration', 'gmail', { simulationOnly: true });
      return { authorizationUrl: '#settings', simulation: 'demo-only' };
    }
    if (verb === 'POST' && pathname === '/v1/integrations/gmail/disconnect') {
      state.gmailStatus = { status: 'DISCONNECTED', demo: true };
      audit('gmail.demo_disconnected', 'integration', 'gmail', { simulationOnly: true });
      return { status: 'DISCONNECTED', simulation: 'demo-only' };
    }
    if (verb === 'GET' && pathname === '/v1/dags') return [...state.dagRuns.values()].map(dagRunCopy);
    if (verb === 'POST' && pathname === '/v1/dags') {
      if (!body || typeof body.id !== 'string' || !body.id.trim()) throw makeError('INVALID_DAG', 'Workflow id is required.');
      const key = JSON.stringify([DEMO_SCOPE.tenantId, DEMO_SCOPE.businessId, body.id]);
      if (state.dagRuns.has(key)) throw makeError('DAG_RUN_EXISTS', 'Workflow id already exists in this demo workspace.', 409);
      const graph = validateDag(body.nodes);
      const at = nowIso();
      const run = {
        id: body.id, tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId,
        createdBy: 'demo-operator', status: 'active', pauseReason: null, createdAt: at, updatedAt: at,
        nodes: [...graph.values()].map((item) => ({
          id: item.id, kind: item.kind, dependsOn: [...(item.dependsOn ?? [])], input: COPY(item.input ?? null),
          state: (item.dependsOn ?? []).length ? 'blocked' : 'ready', result: null,
          claimGeneration: 0, claimToken: null, claimedBy: null, claimedAt: null,
          completedBy: null, completedAt: null, interruptedAt: null, updatedAt: at,
        })),
      };
      state.dagRuns.set(key, run);
      audit('dag.created', 'dag_run', run.id, { nodeCount: run.nodes.length, simulationOnly: true });
      return dagRunCopy(run);
    }
    if (parts[0] === 'v1' && parts[1] === 'dags' && parts.length >= 3) {
      const run = runById(parts[2]);
      const action = parts[3];
      if (!action && verb === 'GET') return dagRunCopy(run);
      if (action === 'pause' && verb === 'POST' && parts.length === 4) {
        if (run.status === 'completed' || run.status === 'stopped') throw makeError('DAG_RUN_TERMINAL', 'A completed workflow cannot be paused.', 409);
        if (!body || typeof body.reason !== 'string' || !body.reason.trim()) throw makeError('INVALID_DAG_PAUSE', 'Pause reason is required.');
        run.status = 'paused'; run.pauseReason = body.reason.trim(); run.updatedAt = nowIso();
        for (const node of run.nodes) if (node.state === 'running') {
          node.state = 'interrupted'; node.claimToken = null; node.interruptedAt = nowIso(); node.updatedAt = node.interruptedAt;
        }
        audit('dag.paused', 'dag_run', run.id, { reason: run.pauseReason, simulationOnly: true });
        return dagRunCopy(run);
      }
      if (action === 'resume' && verb === 'POST' && parts.length === 4) {
        if (run.status !== 'paused') throw makeError('DAG_RUN_NOT_PAUSED', 'Workflow is not paused.', 409);
        run.status = 'active'; run.pauseReason = null; run.updatedAt = nowIso();
        audit('dag.resumed', 'dag_run', run.id, { simulationOnly: true });
        return dagRunCopy(run);
      }
      if (action === 'nodes' && parts.length === 6) {
        const node = run.nodes.find((entry) => entry.id === parts[4]);
        if (!node) throw makeError('NOT_FOUND', 'Workflow step was not found.', 404);
        const nodeAction = parts[5];
        if (nodeAction === 'claim' && verb === 'POST') {
          if (node.kind === 'human_gate') throw makeError('DAG_HUMAN_GATE_REQUIRED', 'Human gate steps need an explicit decision.', 409);
          if (run.status !== 'active' || node.state !== 'ready') throw makeError('DAG_NODE_NOT_READY', 'Workflow step is not ready to claim.', 409);
          const workerId = typeof body?.workerId === 'string' && body.workerId ? body.workerId : 'demo-worker';
          node.state = 'running'; node.claimGeneration += 1; node.claimToken = state.idFactory('fence');
          node.claimedBy = workerId; node.claimedAt = nowIso(); node.updatedAt = node.claimedAt; run.updatedAt = node.updatedAt;
          audit('dag.node_claimed', 'dag_node', node.id, { runId: run.id, workerId, simulationOnly: true });
          const { claimToken, ...nodeView } = node;
          return { runId: run.id, node: COPY(nodeView), fencingToken: claimToken, simulation: 'demo-only' };
        }
        if (nodeAction === 'complete' && verb === 'POST') {
          if (node.kind === 'human_gate') throw makeError('DAG_HUMAN_GATE_REQUIRED', 'Use the explicit human gate route.', 409);
          if (node.state !== 'running' || !body?.fencingToken || node.claimToken !== body.fencingToken) throw makeError('DAG_FENCE_REJECTED', 'Current demo fencing token is required.', 409);
          node.result = COPY(body.result ?? null); node.state = 'completed'; node.completedBy = 'demo-worker';
          node.completedAt = nowIso(); node.updatedAt = node.completedAt; node.claimToken = null;
          refreshDag(run); audit('dag.node_completed', 'dag_node', node.id, { runId: run.id, simulationOnly: true });
          return dagRunCopy(run);
        }
        if (nodeAction === 'recover' && verb === 'POST') {
          if (run.status === 'paused') throw makeError('DAG_RUN_NOT_ACTIVE', 'Resume the workflow before recovering a step.', 409);
          if (run.status !== 'active' || node.state !== 'interrupted') throw makeError('DAG_NODE_NOT_INTERRUPTED', 'Only interrupted steps can be recovered.', 409);
          if (!node.dependsOn.every((id) => run.nodes.find((entry) => entry.id === id)?.state === 'completed')) throw makeError('DAG_DEPENDENCIES_INCOMPLETE', 'Workflow dependencies are incomplete.', 409);
          node.state = 'ready'; node.claimToken = null; node.claimedBy = null; node.claimedAt = null; node.interruptedAt = null; node.updatedAt = nowIso();
          audit('dag.node_resumed', 'dag_node', node.id, { runId: run.id, simulationOnly: true });
          return dagRunCopy(run);
        }
        if (nodeAction === 'gate' && verb === 'POST') {
          if (node.kind !== 'human_gate' || node.state !== 'ready' || run.status !== 'active') throw makeError('DAG_NODE_NOT_READY', 'Human gate step is not ready for a decision.', 409);
          const decision = body?.decision;
          if (!['pass', 'stop'].includes(decision)) throw makeError('INVALID_GATE_DECISION', 'Decision must be pass or stop.');
          const at = nowIso();
          node.result = { decision, simulationOnly: true }; node.state = decision === 'stop' ? 'stopped' : 'completed';
          node.completedBy = 'demo-operator'; node.completedAt = at; node.updatedAt = at;
          if (decision === 'stop') {
            run.status = 'stopped';
            for (const other of run.nodes) if (other !== node && !['completed', 'stopped'].includes(other.state)) {
              other.state = 'stopped'; other.claimToken = null; other.stoppedAt = at; other.updatedAt = at;
            }
          } else refreshDag(run);
          audit('dag.gate_decided', 'dag_node', node.id, { runId: run.id, decision, simulationOnly: true });
          return dagRunCopy(run);
        }
      }
      throw makeError('NOT_FOUND', 'Unknown demo route.', 404);
    }
    if (verb === 'POST' && pathname === '/v1/demo/advance') return advanceDag(body?.runId ?? null);
    if (verb === 'POST' && pathname === '/v1/demo/signals') {
      const item = campaign(body?.campaignId);
      const allowedTypes = new Set(['open_signal', 'click_observed', 'reply_received', 'bounce_detected', 'unsubscribed']);
      if (!allowedTypes.has(body?.type)) throw makeError('INVALID_SIGNAL', 'Supported demo signals are open_signal, click_observed, reply_received, bounce_detected, and unsubscribed.');
      const recipientId = body.recipientId ?? item.draft.recipientIds[0];
      if (!item.draft.recipientIds.includes(recipientId)) throw makeError('RECIPIENT_NOT_IN_CAMPAIGN', 'Signal recipient is not part of this campaign.');
      if (body.type === 'unsubscribed' || body.type === 'bounce_detected') {
        const current = recipient(recipientId);
        current.suppression = {
          recipientId, reason: body.type === 'unsubscribed' ? 'UNSUBSCRIBED' : 'HARD_BOUNCE',
          source: 'DEMO', createdAt: nowIso(),
        };
      }
      appendSignal(item, recipientId, body.type, { simulationOnly: true });
      audit(`signal.${body.type}`, 'recipient', recipientId, { campaignId: item.id, simulationOnly: true });
      return {
        campaignId: item.id, recipientId, type: body.type, recorded: true,
        ...(body.type === 'open_signal' ? { interpretation: 'Image request simulated; it is not proof that a person read the email.' } : {}),
        simulation: 'demo-only',
      };
    }
    if (verb === 'POST' && pathname === '/v1/templates') {
      const input = body;
      if (!input || typeof input.id !== 'string' || !Number.isInteger(Number(input.version)) || !Array.isArray(input.variables)) throw makeError('INVALID_TEMPLATE', 'Template id, version, and variables are required.');
      if (state.templates.some((item) => item.id === input.id && item.version === Number(input.version))) throw makeError('TEMPLATE_VERSION_CONFLICT', 'Template versions are immutable in demo mode.', 409);
      const created = { id: input.id, version: Number(input.version), subject: String(input.subject ?? ''), html: String(input.html ?? ''), plainText: String(input.plainText ?? ''), variables: COPY(input.variables) };
      state.templates.push(created); audit('template.created', 'template', created.id, { version: created.version, simulationOnly: true });
      return COPY(created);
    }
    if (verb === 'POST' && pathname === '/v1/recipients') return setRecipient(body);
    if (parts[0] === 'v1' && parts[1] === 'recipients' && parts[3] === 'suppression' && verb === 'POST' && parts.length === 4) {
      const current = recipient(parts[2]);
      const reason = body?.reason;
      if (!['UNSUBSCRIBED', 'HARD_BOUNCE', 'MANUAL_SUPPRESSION'].includes(reason)) throw makeError('INVALID_SUPPRESSION', 'Suppression reason is not supported.');
      current.suppression = { recipientId: current.id, reason, source: 'DEMO', createdAt: nowIso() };
      audit('suppression.synced', 'recipient', current.id, { reason, simulationOnly: true });
      return COPY(current.suppression);
    }
    if (verb === 'POST' && pathname === '/v1/attachments') {
      if (!body || typeof body.id !== 'string' || typeof body.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(body.sha256)) throw makeError('INVALID_ATTACHMENT', 'Attachment metadata needs an id and SHA-256.');
      if (state.attachments.some((item) => item.id === body.id)) throw makeError('ATTACHMENT_EXISTS', 'Attachment references are immutable in demo mode.', 409);
      const created = { ...COPY(body), sha256: body.sha256.toLowerCase(), version: Number(body.version ?? 1), size: Number(body.size) };
      state.attachments.push(created); audit('attachment.registered', 'attachment', created.id, { version: created.version, simulationOnly: true });
      return COPY(created);
    }
    if (verb === 'POST' && pathname === '/v1/campaigns') {
      const draft = normalizeDraft(body);
      const id = state.idFactory('campaign');
      const at = nowIso();
      const item = { id, tenantId: DEMO_SCOPE.tenantId, businessId: DEMO_SCOPE.businessId, createdBy: 'demo-operator', createdAt: at, updatedAt: at, status: 'draft', draftRevision: 1, draft, approval: null, approvals: [], queueIds: [], blockedRecipients: [], signals: [] };
      state.campaigns.set(id, item); audit('campaign.draft_created', 'campaign', id, { draftRevision: 1, simulationOnly: true });
      return campaignCopy(item);
    }
    const campaignRoute = parts[0] === 'v1' && parts[1] === 'campaigns' ? parts[2] : null;
    if (campaignRoute) {
      const item = campaign(campaignRoute);
      const action = parts[3];
      if (parts.length > (action ? 4 : 3)) throw makeError('NOT_FOUND', 'Unknown demo route.', 404);
      if (!action && verb === 'GET') return campaignCopy(item);
      if (!action && verb === 'PATCH') {
        if (!['draft', 'approved', 'paused'].includes(item.status)) throw makeError('CAMPAIGN_NOT_EDITABLE', 'Campaign cannot be edited in its current state.', 409);
        item.draft = normalizeDraft({ ...item.draft, ...body }); item.draftRevision += 1;
        item.status = 'draft'; item.approval = null; item.updatedAt = nowIso();
        audit('campaign.draft_updated', 'campaign', item.id, { draftRevision: item.draftRevision, simulationOnly: true });
        return campaignCopy(item);
      }
      if (action === 'preview' && verb === 'POST') return preview(item, body ?? {});
      if (action === 'approve' && verb === 'POST') {
        if (!['draft', 'approved', 'paused'].includes(item.status)) throw makeError('CAMPAIGN_NOT_APPROVABLE', 'Campaign cannot be approved in this state.', 409);
        const result = preview(item, { draftHash: body?.draftHash });
        const approved = { payloadHash: result.draftHash, snapshot: snapshot(item), approvedBy: 'demo-operator', approvedAt: nowIso() };
        item.approval = approved; item.approvals.push(approved); item.status = 'approved'; item.updatedAt = approved.approvedAt;
        audit('campaign.approved', 'campaign', item.id, { payloadHash: approved.payloadHash, draftRevision: item.draftRevision, simulationOnly: true });
        return { campaignId: item.id, status: item.status, payloadHash: approved.payloadHash, approvedAt: approved.approvedAt, simulation: 'demo-only' };
      }
      if (action === 'schedule' && verb === 'POST') return schedule(item, body?.scheduledAt ?? null);
      if (action === 'dispatch' && verb === 'POST') {
        if (state.gmailStatus.status !== 'CONNECTED') throw makeError('GMAIL_NOT_CONNECTED', 'Connect the demo Gmail account before dispatching.', 503);
        return dispatch(item);
      }
      if (action === 'pause' && verb === 'POST') {
        let cancelled = 0;
        for (const key of item.queueIds) {
          const job = state.queue.get(key);
          if (job?.status !== 'pending') continue;
          job.status = 'cancelled'; job.completedAt = nowIso();
          const usage = state.dailyUsage.get(job.day);
          if (usage) usage.reserved = Math.max(0, usage.reserved - 1);
          cancelled += 1;
        }
        item.status = 'paused'; item.updatedAt = nowIso();
        audit('campaign.paused', 'campaign', item.id, { cancelledQueueEntries: cancelled, simulationOnly: true });
        return { campaignId: item.id, status: item.status, cancelledQueueEntries: cancelled, simulation: 'demo-only' };
      }
      if (action === 'report' && verb === 'GET') return report(item);
      throw makeError('NOT_FOUND', 'Unknown demo route.', 404);
    }
    if (verb !== 'GET' && verb !== 'POST' && verb !== 'PATCH') throw makeError('NOT_FOUND', 'Unknown demo route.', 404);
    throw makeError('NOT_FOUND', 'Unknown demo route.', 404);

    function normalizeDraft(input) {
      if (!input || !Array.isArray(input.recipientIds) || input.recipientIds.length < 1) throw makeError('INVALID_RECIPIENTS', 'Choose at least one recipient.');
      const tmpl = template(input.templateId, input.templateVersion);
      const recipientIds = [...new Set(input.recipientIds)];
      recipientIds.forEach(recipient);
      const attachmentIds = [...new Set(input.attachmentIds ?? [])];
      attachmentIds.forEach((id) => {
        if (!state.attachments.some((item) => item.id === id)) throw makeError('ATTACHMENT_NOT_FOUND', 'Attachment was not found in the demo workspace.', 404);
      });
      return {
        name: String(input.name ?? '').trim(), templateId: tmpl.id, templateVersion: tmpl.version,
        recipientIds, recipientVariables: COPY(input.recipientVariables ?? {}), attachmentIds,
      };
    }
  }

  return {
    request: async (path, body, method = 'GET') => {
      try {
        // Keep all mock responses isolated from mutable demo state.
        const result = await request(path, body, method);
        return COPY(result);
      } catch (error) {
        throw error;
      }
    },
  };
}
