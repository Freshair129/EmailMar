import { createHash, randomUUID } from 'node:crypto';
import { fail, notFound, requireContext, requirePermission } from './errors.mjs';
import { InMemoryStore, StorePersistenceError } from './store.mjs';

const EMAIL_MARKETING = 'EMAIL_MARKETING';
const GRANTED = 'GRANTED';
const VARIABLE_PATTERN = /{{\s*([A-Za-z_][\w.-]*)\s*}}/g;
const UNSAFE_HTML = /<\s*(script|iframe|object|embed|svg)\b|\bon[a-z]+\s*=|javascript\s*:/i;
const HASH_PATTERN = /^[a-f\d]{64}$/i;

const copy = (value) => structuredClone(value);
const scopeKey = (context) => JSON.stringify([context.tenantId, context.businessId]);
const scopedId = (context, id) => `${scopeKey(context)}:${id}`;
const hash = (value) => createHash('sha256').update(stableJson(value)).digest('hex');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertText(value, label, max = 200_000) {
  if (typeof value !== 'string' || value.length > max) fail('INVALID_INPUT', `${label} must be text no longer than ${max} characters.`);
  return value;
}

function assertEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) {
    fail('INVALID_EMAIL', 'Recipient email address is invalid.');
  }
  return value;
}

function assertTemplate(template) {
  const id = assertText(template.id, 'Template id', 100).trim();
  const version = Number(template.version);
  if (!id || !Number.isInteger(version) || version < 1) fail('INVALID_TEMPLATE', 'Template id and positive integer version are required.');
  const variables = [...new Set(template.variables ?? [])];
  if (variables.some((name) => typeof name !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(name))) {
    fail('INVALID_TEMPLATE', 'Template variables must be simple variable names.');
  }
  const value = {
    id,
    version,
    subject: assertText(template.subject, 'Template subject', 998),
    html: assertText(template.html, 'Template HTML'),
    plainText: assertText(template.plainText, 'Template plain text'),
    variables,
  };
  if (!value.subject.trim() || !value.html.trim() || !value.plainText.trim()) fail('INVALID_TEMPLATE', 'Subject, HTML, and plain text are required.');
  if (UNSAFE_HTML.test(value.html)) fail('UNSAFE_HTML', 'Email HTML cannot contain scripts, active content, event handlers, or javascript URLs.');
  const known = new Set(variables);
  for (const source of [value.subject, value.html, value.plainText]) {
    for (const match of source.matchAll(VARIABLE_PATTERN)) {
      if (!known.has(match[1])) fail('INVALID_TEMPLATE', `Template variable ${match[1]} is not declared.`);
    }
  }
  return value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function render(source, variables, html = false) {
  return source.replace(VARIABLE_PATTERN, (_match, name) => {
    const value = variables[name] ?? '';
    return html ? escapeHtml(value) : String(value);
  });
}

function freezeSnapshot(snapshot) {
  return deepFreeze(copy(snapshot));
}

function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'Clock returned an invalid date.', 500);
  return date.toISOString();
}

function utcDay(iso) {
  return iso.slice(0, 10);
}

function isGranted(recipient) {
  return recipient.consents.some((entry) => entry.type === EMAIL_MARKETING && entry.status === GRANTED);
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'PROVIDER_ERROR';
}

function safeAuditValue(value) {
  return value == null ? null : String(value).slice(0, 160);
}

export class EmailMarService {
  constructor({
    store = new InMemoryStore(),
    gmail = null,
    files = null,
    clock = () => new Date(),
    idFactory = randomUUID,
    tokenFactory = randomUUID,
    publicBaseUrl = 'http://localhost:8788',
    dailyLimit = 500,
  } = {}) {
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 500) fail('INVALID_DAILY_LIMIT', 'Daily limit must be between 1 and 500.');
    this.store = store;
    this.gmail = gmail;
    this.files = files;
    this.clock = clock;
    this.idFactory = idFactory;
    this.tokenFactory = tokenFactory;
    this.publicBaseUrl = new URL(publicBaseUrl).origin;
    this.dailyLimit = dailyLimit;
  }

  #assertHealthy() {
    this.store.assertHealthy?.();
  }

  #audit(context, action, subjectType, subjectId, details = {}) {
    const event = {
      id: this.idFactory(),
      tenantId: context.tenantId,
      businessId: context.businessId,
      actorId: context.actorId,
      action,
      subjectType,
      subjectId: safeAuditValue(subjectId),
      at: isoNow(this.clock),
      details: copy(details),
    };
    this.store.audit.push(event);
    this.store.checkpoint?.();
    return event;
  }

  #template(context, id, version) {
    const template = this.store.templates.get(scopedId(context, `${id}@${version}`));
    if (!template) fail('TEMPLATE_NOT_FOUND', 'Email template version not found in this scope.', 404);
    return template;
  }

  #recipient(context, id) {
    const recipient = this.store.recipients.get(scopedId(context, id));
    if (!recipient) fail('RECIPIENT_NOT_FOUND', 'Recipient not found in this scope.', 404);
    return recipient;
  }

  #campaign(context, id) {
    const campaign = this.store.campaigns.get(id);
    if (!campaign || campaign.tenantId !== context.tenantId || campaign.businessId !== context.businessId) notFound();
    return campaign;
  }

  #normalizeDraft(context, input) {
    const template = this.#template(context, input.templateId, input.templateVersion);
    const recipientIds = [...new Set(input.recipientIds ?? [])];
    if (!recipientIds.length || recipientIds.some((id) => typeof id !== 'string' || !id)) fail('INVALID_RECIPIENTS', 'At least one recipient id is required.');
    if (recipientIds.length > 500) fail('DAILY_LIMIT_EXCEEDED', 'A campaign cannot contain more than 500 recipients.');
    const recipientVariables = copy(input.recipientVariables ?? {});
    for (const id of recipientIds) {
      this.#recipient(context, id);
      const values = recipientVariables[id] ?? {};
      if (!values || typeof values !== 'object' || Array.isArray(values)) fail('INVALID_VARIABLES', 'Recipient variables must be objects keyed by recipient id.');
      for (const [name, value] of Object.entries(values)) {
        if (!template.variables.includes(name) || !['string', 'number', 'boolean'].includes(typeof value)) {
          fail('INVALID_VARIABLES', `Variable ${name} is undeclared or has an unsupported value.`);
        }
      }
    }
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    const attachments = attachmentIds.map((id) => {
      const item = this.store.attachments.get(scopedId(context, id));
      if (!item) fail('ATTACHMENT_NOT_FOUND', 'Attachment reference not found in this scope.', 404);
      return item;
    });
    return {
      name: assertText(input.name, 'Campaign name', 200).trim(),
      templateId: template.id,
      templateVersion: template.version,
      recipientIds,
      recipientVariables,
      attachmentIds,
    };
  }

  #snapshot(context, campaign) {
    const draft = campaign.draft;
    const template = this.#template(context, draft.templateId, draft.templateVersion);
    const recipients = draft.recipientIds.map((id) => {
      const recipient = this.#recipient(context, id);
      return { id, email: recipient.email, variables: copy(draft.recipientVariables[id] ?? {}) };
    });
    const attachments = draft.attachmentIds.map((id) => copy(this.store.attachments.get(scopedId(context, id))));
    const payload = {
      campaignId: campaign.id,
      name: draft.name,
      template: copy(template),
      recipients,
      attachments,
      senderIdentity: this.#senderIdentity(context),
    };
    return { ...payload, payloadHash: hash(payload) };
  }

  #hasSenderIdentity() {
    return typeof this.gmail?.connectionIdentity === 'function';
  }

  #senderIdentity(context) {
    if (!this.#hasSenderIdentity()) return null;
    const identity = this.gmail.connectionIdentity({ tenantId: context.tenantId, businessId: context.businessId });
    if (identity == null) return null;
    if (typeof identity?.then === 'function'
      || typeof identity.connectionId !== 'string' || !identity.connectionId
      || typeof identity.accountId !== 'string' || !identity.accountId
      || typeof identity.email !== 'string' || !identity.email) {
      fail('GMAIL_IDENTITY_UNAVAILABLE', 'Gmail connection identity is invalid.', 503);
    }
    return { connectionId: identity.connectionId, accountId: identity.accountId, email: identity.email };
  }

  #sendGateReason(context, campaign, job, approvedSnapshot) {
    if (job.status !== 'sending') return 'QUEUE_ENTRY_NOT_SENDING';
    if (utcDay(isoNow(this.clock)) !== job.day) return 'DAILY_LIMIT_DAY_CHANGED';
    const recipient = this.#recipient(context, job.recipientId);
    const eligibility = this.#eligibility(context, recipient, job.approvedEmail);
    if (!eligibility.eligible) return eligibility.reason;
    if (campaign.status === 'paused' || !campaign.approval || campaign.approval.payloadHash !== job.approvalHash) {
      return 'CAMPAIGN_PAUSED_OR_APPROVAL_STALE';
    }
    if (this.#hasSenderIdentity()) {
      const liveIdentity = this.#senderIdentity(context);
      if (!liveIdentity || stableJson(liveIdentity) !== stableJson(approvedSnapshot.senderIdentity)) {
        return 'GMAIL_SENDER_CHANGED_OR_DISCONNECTED';
      }
    }
    return null;
  }

  #beforeRequestError(reason) {
    const error = new Error('The send was blocked before Gmail accepted a request.');
    error.code = reason;
    error.safeToRetry = true;
    error.requestStarted = false;
    error.emarBeforeRequestBlock = true;
    return error;
  }

  #verifyBeforeRequest(context, campaign, job, approvedSnapshot) {
    const reason = this.#sendGateReason(context, campaign, job, approvedSnapshot);
    if (reason) throw this.#beforeRequestError(reason);
    this.store.checkpoint?.();
  }

  #eligibility(context, recipient, approvedEmail = recipient.email) {
    const suppression = this.store.suppressions.get(scopedId(context, recipient.id));
    if (suppression) return { eligible: false, reason: suppression.reason };
    if (!isGranted(recipient)) return { eligible: false, reason: 'MARKETING_CONSENT_NOT_GRANTED' };
    if (recipient.email !== approvedEmail) return { eligible: false, reason: 'RECIPIENT_ADDRESS_CHANGED_REAPPROVAL_REQUIRED' };
    return { eligible: true, reason: null };
  }

  #requireApprovedHuman(context) {
    requirePermission(context, 'campaign.approve');
    if (context.actorType !== 'human') fail('HUMAN_APPROVAL_REQUIRED', 'Only an authenticated human can approve a campaign.', 403);
  }

  #dailyKey(context, day) {
    return day;
  }

  #usage(context, day) {
    const key = this.#dailyKey(context, day);
    if (!this.store.dailyUsage.has(key)) this.store.dailyUsage.set(key, { reserved: 0, consumed: 0 });
    return this.store.dailyUsage.get(key);
  }

  #haltAutomations(context, recipientId, signal) {
    for (const workflow of this.store.automations.values()) {
      if (workflow.tenantId !== context.tenantId || workflow.businessId !== context.businessId || workflow.recipientId !== recipientId) continue;
      if (workflow.status === 'scheduled' || workflow.status === 'running') {
        workflow.status = 'paused';
        workflow.pauseReason = signal;
        workflow.updatedAt = isoNow(this.clock);
        this.#audit(context, 'automation.paused', 'automation', workflow.id, { reason: signal });
      }
    }
  }

  createTemplate(context, input) {
    requirePermission(context, 'template.write');
    requireContext(context);
    this.#assertHealthy();
    const template = assertTemplate({ ...input, id: input.id ?? this.idFactory() });
    const key = scopedId(context, `${template.id}@${template.version}`);
    const previous = this.store.templates.get(key);
    if (previous && stableJson(previous) !== stableJson(template)) fail('TEMPLATE_VERSION_CONFLICT', 'Template versions are immutable.', 409);
    if (!previous) {
      this.store.templates.set(key, deepFreeze(copy(template)));
      this.#audit(context, 'template.created', 'template', template.id, { version: template.version });
    }
    return copy(template);
  }

  registerAttachment(context, input) {
    requirePermission(context, 'files.projection.write');
    requireContext(context);
    this.#assertHealthy();
    const attachment = {
      id: assertText(input.id ?? this.idFactory(), 'Attachment id', 100),
      fileRef: assertText(input.fileRef, 'Files reference', 500),
      sha256: assertText(input.sha256, 'Attachment SHA-256', 64).toLowerCase(),
      filename: assertText(input.filename, 'Attachment filename', 200),
      mimeType: assertText(input.mimeType, 'Attachment MIME type', 100),
      size: Number(input.size),
      version: Number(input.version ?? 1),
    };
    if (!HASH_PATTERN.test(attachment.sha256) || !Number.isSafeInteger(attachment.size) || attachment.size < 0 || !Number.isInteger(attachment.version) || attachment.version < 1 || !/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType)) {
      fail('INVALID_ATTACHMENT', 'Attachment metadata must include a SHA-256, byte size, and positive version.');
    }
    const key = scopedId(context, attachment.id);
    if (this.store.attachments.has(key)) fail('ATTACHMENT_EXISTS', 'Attachment references are immutable; use a new versioned id.', 409);
    this.store.attachments.set(key, deepFreeze(copy(attachment)));
    this.#audit(context, 'attachment.registered', 'attachment', attachment.id, { sha256: attachment.sha256, version: attachment.version });
    return copy(attachment);
  }

  upsertRecipient(context, input) {
    requirePermission(context, 'crm.projection.write');
    requireContext(context);
    this.#assertHealthy();
    const id = assertText(input.id, 'Recipient id', 100);
    const email = assertEmail(input.email);
    const consents = (input.consents ?? []).map((item) => ({ type: item.type, status: item.status, observedAt: item.observedAt ?? isoNow(this.clock) }));
    const displayName = assertText(input.displayName ?? '', 'Recipient name', 160);
    const recipient = { id, email, displayName, consents };
    const key = scopedId(context, id);
    const previous = this.store.recipients.get(key);
    this.store.recipients.set(key, recipient);
    this.#audit(context, previous ? 'recipient.projection_updated' : 'recipient.projection_created', 'recipient', id, { source: context.inputSource ?? 'CRM', marketingConsent: isGranted(recipient) });
    return copy(recipient);
  }

  syncSuppression(context, recipientId, reason, source = 'CRM') {
    requirePermission(context, 'crm.projection.write');
    requireContext(context);
    this.#assertHealthy();
    this.#recipient(context, recipientId);
    if (!['UNSUBSCRIBED', 'HARD_BOUNCE', 'MANUAL_SUPPRESSION'].includes(reason)) fail('INVALID_SUPPRESSION', 'Suppression reason is not supported.');
    const suppression = { recipientId, reason, source: safeAuditValue(source), createdAt: isoNow(this.clock) };
    this.store.suppressions.set(scopedId(context, recipientId), suppression);
    const signal = reason === 'UNSUBSCRIBED' ? 'unsubscribed' : reason === 'HARD_BOUNCE' ? 'bounce_detected' : 'manual_suppression';
    this.#recordSignal(context, recipientId, signal, { source: safeAuditValue(source) });
    this.#audit(context, 'suppression.synced', 'recipient', recipientId, { reason, source: safeAuditValue(source) });
    return copy(suppression);
  }

  createCampaignDraft(context, input) {
    requirePermission(context, 'campaign.write');
    requireContext(context);
    this.#assertHealthy();
    const draft = this.#normalizeDraft(context, input);
    if (!draft.name) fail('INVALID_INPUT', 'Campaign name is required.');
    const id = this.idFactory();
    const campaign = {
      id,
      tenantId: context.tenantId,
      businessId: context.businessId,
      createdBy: context.actorId,
      createdAt: isoNow(this.clock),
      updatedAt: isoNow(this.clock),
      status: 'draft',
      draftRevision: 1,
      draft,
      approval: null,
      approvals: [],
      queueIds: [],
      blockedRecipients: [],
      signals: [],
    };
    this.store.campaigns.set(id, campaign);
    this.#audit(context, 'campaign.draft_created', 'campaign', id, { draftRevision: 1 });
    return this.getCampaign(context, id);
  }

  updateCampaignDraft(context, campaignId, patch) {
    requirePermission(context, 'campaign.write');
    this.#assertHealthy();
    const campaign = this.#campaign(context, campaignId);
    if (!['draft', 'approved', 'paused'].includes(campaign.status)) fail('CAMPAIGN_NOT_EDITABLE', 'Campaign cannot be edited in its current state.', 409);
    const merged = this.#normalizeDraft(context, { ...campaign.draft, ...patch });
    campaign.draft = merged;
    campaign.draftRevision += 1;
    campaign.status = 'draft';
    campaign.approval = null;
    campaign.updatedAt = isoNow(this.clock);
    this.#audit(context, 'campaign.draft_updated', 'campaign', campaignId, { draftRevision: campaign.draftRevision });
    return this.getCampaign(context, campaignId);
  }

  getCampaign(context, campaignId) {
    requirePermission(context, 'campaign.read');
    requireContext(context);
    this.#assertHealthy();
    const campaign = this.#campaign(context, campaignId);
    return {
      id: campaign.id,
      name: campaign.draft.name,
      status: campaign.status,
      draftRevision: campaign.draftRevision,
      draft: copy(campaign.draft),
      approval: campaign.approval ? { payloadHash: campaign.approval.payloadHash, approvedAt: campaign.approval.approvedAt, approvedBy: campaign.approval.approvedBy } : null,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    };
  }

  previewCampaign(context, campaignId, options = {}) {
    requirePermission(context, 'campaign.read');
    this.#assertHealthy();
    const campaign = this.#campaign(context, campaignId);
    const snapshot = this.#snapshot(context, campaign);
    if (options.draftHash && options.draftHash !== snapshot.payloadHash) fail('DRAFT_CHANGED', 'Draft changed; refresh the preview before approving.', 409);
    const sampleId = options.recipientId ?? snapshot.recipients[0].id;
    const sample = snapshot.recipients.find((recipient) => recipient.id === sampleId);
    if (!sample) fail('RECIPIENT_NOT_IN_CAMPAIGN', 'Preview recipient is not in this campaign.');
    const sampleTemplate = snapshot.template;
    const eligible = snapshot.recipients.map((recipient) => {
      const current = this.#recipient(context, recipient.id);
      return { recipientId: recipient.id, ...this.#eligibility(context, current, recipient.email) };
    });
    return {
      campaignId,
      draftRevision: campaign.draftRevision,
      draftHash: snapshot.payloadHash,
      template: { id: sampleTemplate.id, version: sampleTemplate.version },
      recipients: { total: eligible.length, eligible: eligible.filter((item) => item.eligible).length, withheld: eligible.filter((item) => !item.eligible) },
      sample: {
        recipientId: sample.id,
        subject: render(sampleTemplate.subject, sample.variables),
        html: render(sampleTemplate.html, sample.variables, true),
        plainText: render(sampleTemplate.plainText, sample.variables),
      },
      tracking: { openSignalMeaning: 'Image request observed; it does not prove a human read the message.', customJavaScript: false },
    };
  }

  approveCampaign(context, campaignId, { draftHash = null } = {}) {
    this.#requireApprovedHuman(context);
    this.#assertHealthy();
    const campaign = this.#campaign(context, campaignId);
    if (!['draft', 'approved', 'paused'].includes(campaign.status)) fail('CAMPAIGN_NOT_APPROVABLE', 'Campaign cannot be approved in its current state.', 409);
    const snapshot = this.#snapshot(context, campaign);
    if (draftHash && draftHash !== snapshot.payloadHash) fail('DRAFT_CHANGED', 'Draft changed; refresh the preview before approving.', 409);
    const immutableSnapshot = freezeSnapshot(snapshot);
    const approval = deepFreeze({ payloadHash: snapshot.payloadHash, snapshot: immutableSnapshot, approvedBy: context.actorId, approvedAt: isoNow(this.clock) });
    campaign.approval = approval;
    campaign.approvals.push(approval);
    campaign.status = 'approved';
    campaign.updatedAt = approval.approvedAt;
    this.#audit(context, 'campaign.approved', 'campaign', campaignId, { payloadHash: approval.payloadHash, draftRevision: campaign.draftRevision });
    return { campaignId, status: campaign.status, payloadHash: approval.payloadHash, approvedAt: approval.approvedAt };
  }

  scheduleCampaign(context, campaignId, { scheduledAt = null } = {}) {
    requirePermission(context, 'campaign.schedule');
    this.#assertHealthy();
    const campaign = this.#campaign(context, campaignId);
    const approval = campaign.approval;
    if (!['approved', 'scheduled'].includes(campaign.status) || !approval) fail('APPROVAL_REQUIRED', 'A human-approved campaign snapshot is required before scheduling.', 409);
    const current = this.#snapshot(context, campaign);
    if (current.payloadHash !== approval.payloadHash) fail('REAPPROVAL_REQUIRED', 'Campaign content, recipients, or attachments changed after approval.', 409);
    const now = new Date(isoNow(this.clock));
    const date = scheduledAt === null ? now : new Date(scheduledAt);
    if (!Number.isFinite(date.getTime())) fail('INVALID_SCHEDULE', 'scheduledAt must be a valid date.');
    const scheduleIso = date.toISOString();
    const scheduleKey = `${campaign.id}:${approval.payloadHash}`;
    const previousIds = this.store.scheduleKeys.get(scheduleKey);
    if (previousIds) return this.#scheduleResult(campaign, previousIds);
    if (date < now) fail('INVALID_SCHEDULE', 'scheduledAt cannot be in the past.');

    const approvedById = new Map(approval.snapshot.recipients.map((recipient) => [recipient.id, recipient]));
    const eligible = [];
    const blocked = [];
    for (const snapshotRecipient of approval.snapshot.recipients) {
      const currentRecipient = this.#recipient(context, snapshotRecipient.id);
      const result = this.#eligibility(context, currentRecipient, snapshotRecipient.email);
      if (result.eligible) eligible.push(approvedById.get(snapshotRecipient.id));
      else blocked.push({ recipientId: snapshotRecipient.id, reason: result.reason, at: scheduleIso });
    }
    const day = utcDay(scheduleIso);
    const usage = this.#usage(context, day);
    if (usage.reserved + usage.consumed + eligible.length > this.dailyLimit) {
      fail('DAILY_LIMIT_EXCEEDED', `Scheduling would exceed the ${this.dailyLimit}-message daily limit.`, 429);
    }
    const ids = [];
    for (const recipient of eligible) {
      const id = this.idFactory();
      const key = hash([campaign.id, approval.payloadHash, recipient.id]);
      const job = {
        id, key, campaignId: campaign.id, tenantId: context.tenantId, businessId: context.businessId,
        recipientId: recipient.id, approvedEmail: recipient.email, variables: copy(recipient.variables),
        approvalHash: approval.payloadHash, scheduledAt: scheduleIso, day, status: 'pending',
        createdAt: scheduleIso, startedAt: null, completedAt: null, errorCode: null, quotaConsumed: false,
      };
      const existing = this.store.queue.get(key);
      if (!existing) {
        this.store.queue.set(key, job);
        ids.push(key);
        usage.reserved += 1;
      } else {
        ids.push(key);
      }
    }
    campaign.blockedRecipients = [...campaign.blockedRecipients, ...blocked];
    campaign.queueIds = [...new Set([...campaign.queueIds, ...ids])];
    campaign.status = 'scheduled';
    campaign.updatedAt = scheduleIso;
    this.store.scheduleKeys.set(scheduleKey, ids);
    this.#audit(context, 'campaign.scheduled', 'campaign', campaignId, { payloadHash: approval.payloadHash, scheduledCount: ids.length, withheldCount: blocked.length, day });
    return this.#scheduleResult(campaign, ids);
  }

  #scheduleResult(campaign, ids) {
    return { campaignId: campaign.id, status: campaign.status, queued: ids.length, queueIds: ids.map((key) => this.store.queue.get(key)?.id).filter(Boolean), withheld: copy(campaign.blockedRecipients) };
  }

  pauseCampaign(context, campaignId) {
    requirePermission(context, 'campaign.pause');
    this.#assertHealthy();
    const campaign = this.#campaign(context, campaignId);
    let cancelled = 0;
    for (const key of campaign.queueIds) {
      const job = [...this.store.queue.values()].find((entry) => entry.id === key) ?? this.store.queue.get(key);
      if (job?.status === 'pending') {
        job.status = 'cancelled';
        job.completedAt = isoNow(this.clock);
        this.#usage(context, job.day).reserved = Math.max(0, this.#usage(context, job.day).reserved - 1);
        cancelled += 1;
      }
    }
    const wasPaused = campaign.status === 'paused';
    if (!wasPaused) {
      campaign.status = 'paused';
      campaign.updatedAt = isoNow(this.clock);
    }
    if (!wasPaused || cancelled > 0) this.#audit(context, 'campaign.paused', 'campaign', campaignId, { cancelledQueueEntries: cancelled });
    return { campaignId, status: campaign.status, cancelledQueueEntries: cancelled };
  }

  async dispatchDue(context, { limit = 500, campaignId = null } = {}) {
    requirePermission(context, 'campaign.worker');
    requireContext(context);
    this.#assertHealthy();
    if (campaignId !== null) this.#campaign(context, campaignId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('INVALID_LIMIT', 'Worker batch limit must be between 1 and 500.');
    const now = isoNow(this.clock);
    const due = [...this.store.queue.values()]
      .filter((job) => job.tenantId === context.tenantId && job.businessId === context.businessId && job.status === 'pending' && job.scheduledAt <= now)
      .filter((job) => campaignId === null || job.campaignId === campaignId)
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
      .slice(0, limit);
    const outcomes = [];
    for (const job of due) {
      // Claim synchronously before the first await: overlapping workers cannot claim this entry twice.
      if (job.status !== 'pending') continue;
      const jobNow = isoNow(this.clock);
      job.status = 'sending';
      job.startedAt = jobNow;
      job.quotaConsumed = false;
      const campaign = this.#campaign(context, job.campaignId);
      this.#audit(context, 'queue.claimed', 'queue_entry', job.id, { approvalHash: job.approvalHash });
      const recipient = this.#recipient(context, job.recipientId);
      const eligibility = this.#eligibility(context, recipient, job.approvedEmail);
      if (!eligibility.eligible || campaign.status === 'paused' || !campaign.approval || campaign.approval.payloadHash !== job.approvalHash) {
        job.status = 'cancelled';
        job.errorCode = eligibility.eligible ? 'CAMPAIGN_PAUSED_OR_APPROVAL_STALE' : eligibility.reason;
        job.completedAt = isoNow(this.clock);
        const usage = this.#usage(context, job.day);
        usage.reserved = Math.max(0, usage.reserved - 1);
        job.quotaConsumed = false;
        campaign.blockedRecipients.push({ recipientId: job.recipientId, reason: job.errorCode, at: job.completedAt });
        this.#audit(context, 'queue.withheld', 'queue_entry', job.id, { reason: job.errorCode });
        outcomes.push({ queueId: job.id, status: job.status, reason: job.errorCode });
        continue;
      }
      const reservedUsage = this.#usage(context, job.day);
      const sendDay = utcDay(jobNow);
      const sendUsage = this.#usage(context, sendDay);
      if (sendDay !== job.day) {
        reservedUsage.reserved = Math.max(0, reservedUsage.reserved - 1);
        if (sendUsage.reserved + sendUsage.consumed >= this.dailyLimit) {
          const nextMidnight = new Date(`${sendDay}T00:00:00.000Z`);
          nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
          job.day = utcDay(nextMidnight.toISOString());
          job.scheduledAt = nextMidnight.toISOString();
          job.startedAt = null;
          job.status = 'pending';
          job.quotaConsumed = false;
          this.#usage(context, job.day).reserved += 1;
          this.#audit(context, 'queue.postponed_daily_limit', 'queue_entry', job.id, { day: job.day });
          outcomes.push({ queueId: job.id, status: 'pending', reason: 'DAILY_LIMIT_EXCEEDED', scheduledAt: job.scheduledAt });
          continue;
        }
        sendUsage.reserved += 1;
        job.day = sendDay;
      }
      const usage = this.#usage(context, job.day);
      usage.reserved = Math.max(0, usage.reserved - 1);
      usage.consumed += 1;
      job.quotaConsumed = true;
      let providerInvoked = false;
      try {
        const approvedSnapshot = campaign.approval.snapshot;
        const message = await this.#messageFor(context, approvedSnapshot, job);
        const gateReason = this.#sendGateReason(context, campaign, job, approvedSnapshot);
        if (gateReason) {
          usage.consumed = Math.max(0, usage.consumed - 1);
          job.status = 'cancelled';
          job.quotaConsumed = false;
          job.errorCode = gateReason;
          job.completedAt = isoNow(this.clock);
          this.#audit(context, 'queue.withheld', 'queue_entry', job.id, { reason: job.errorCode });
          outcomes.push({ queueId: job.id, status: job.status, reason: job.errorCode });
          continue;
        }
        if (!this.gmail || typeof this.gmail.send !== 'function') {
          const error = new Error('Gmail adapter is not configured.');
          error.code = 'GMAIL_NOT_CONFIGURED';
          error.safeToRetry = true;
          throw error;
        }
        this.#verifyBeforeRequest(context, campaign, job, approvedSnapshot);
        this.#audit(context, 'queue.send_prepared', 'queue_entry', job.id, { approvalHash: job.approvalHash, quotaConsumed: true });
        const beforeRequest = () => this.#verifyBeforeRequest(context, campaign, job, approvedSnapshot);
        const sendOptions = { message, tenantId: context.tenantId, businessId: context.businessId, beforeRequest };
        if (this.#hasSenderIdentity()) sendOptions.expectedConnectionIdentity = approvedSnapshot.senderIdentity;
        providerInvoked = true;
        const accepted = await this.gmail.send(sendOptions);
        if (accepted?.accepted !== true) {
          const error = new Error('Gmail adapter did not confirm acceptance.');
          error.code = 'GMAIL_ACCEPTANCE_UNCONFIRMED';
          throw error;
        }
        job.status = 'accepted_by_gmail';
        job.completedAt = isoNow(this.clock);
        this.#recordSignal(context, job.recipientId, 'accepted_by_gmail', { campaignId: campaign.id, queueId: job.id });
      } catch (error) {
        if (error instanceof StorePersistenceError) throw error;
        if (error?.emarBeforeRequestBlock === true) {
          job.status = 'cancelled';
          job.errorCode = errorCode(error);
          job.completedAt = isoNow(this.clock);
          usage.consumed = Math.max(0, usage.consumed - 1);
          job.quotaConsumed = false;
          this.#audit(context, 'queue.withheld', 'queue_entry', job.id, { reason: job.errorCode });
          outcomes.push({ queueId: job.id, status: job.status, reason: job.errorCode });
          continue;
        }
        const definitelyNotSent = !providerInvoked || error?.safeToRetry === true;
        job.status = definitelyNotSent ? 'not_sent' : 'SEND_UNKNOWN';
        job.errorCode = errorCode(error);
        job.completedAt = isoNow(this.clock);
        if (definitelyNotSent) {
          usage.consumed = Math.max(0, usage.consumed - 1);
          job.quotaConsumed = false;
        }
        this.#recordSignal(context, job.recipientId, job.status === 'SEND_UNKNOWN' ? 'delivery_unknown' : 'delivery_not_attempted', { campaignId: campaign.id, queueId: job.id });
      }
      this.#audit(context, `queue.${job.status.toLowerCase()}`, 'queue_entry', job.id, { errorCode: job.errorCode });
      outcomes.push({ queueId: job.id, status: job.status, errorCode: job.errorCode });
    }
    return { considered: due.length, outcomes };
  }

  async #messageFor(context, snapshot, job) {
    const variables = job.variables;
    let html = render(snapshot.template.html, variables, true);
    const subject = render(snapshot.template.subject, variables);
    const plainText = render(snapshot.template.plainText, variables);
    const openToken = this.tokenFactory();
    const unsubscribeToken = this.tokenFactory();
    const openUrl = `${this.publicBaseUrl}/v1/tracking/open/${openToken}.gif`;
    const unsubscribeUrl = `${this.publicBaseUrl}/v1/tracking/unsubscribe/${unsubscribeToken}`;
    this.store.trackingTokens.set(openToken, { type: 'open', tenantId: context.tenantId, businessId: context.businessId, campaignId: job.campaignId, recipientId: job.recipientId });
    this.store.trackingTokens.set(unsubscribeToken, { type: 'unsubscribe', tenantId: context.tenantId, businessId: context.businessId, campaignId: job.campaignId, recipientId: job.recipientId });
    html = html.replace(/\bhref=(['"])(https?:\/\/[^'"\s]+)\1/gi, (_match, quote, target) => {
      const token = this.tokenFactory();
      this.store.trackingTokens.set(token, { type: 'click', tenantId: context.tenantId, businessId: context.businessId, campaignId: job.campaignId, recipientId: job.recipientId, target });
      const redirect = `${this.publicBaseUrl}/v1/tracking/click/${token}`;
      return `href=${quote}${redirect}${quote}`;
    });
    html += `<p><a href="${unsubscribeUrl}">Unsubscribe</a></p><img src="${openUrl}" width="1" height="1" alt="" />`;
    const attachments = [];
    for (const descriptor of snapshot.attachments) {
      if (!this.files || typeof this.files.resolveBytes !== 'function') {
        const error = new Error('Files owner adapter is not configured.');
        error.code = 'FILES_NOT_CONFIGURED';
        error.safeToRetry = true;
        throw error;
      }
      const bytes = Buffer.from(await this.files.resolveBytes({ fileRef: descriptor.fileRef, tenantId: context.tenantId, businessId: context.businessId }));
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== descriptor.sha256 || bytes.length !== descriptor.size) fail('ATTACHMENT_INTEGRITY_ERROR', 'Files owner returned bytes that do not match approved attachment metadata.', 409);
      attachments.push({ ...copy(descriptor), bytes });
    }
    return {
      to: job.approvedEmail,
      subject,
      html,
      plainText: `${plainText}\n\nUnsubscribe: ${unsubscribeUrl}`,
      attachments,
      unsubscribeUrl,
      openUrl,
    };
  }

  recordOpen(token) {
    this.#assertHealthy();
    return this.#recordTrackingSignal(token, 'open', 'open_signal');
  }

  recordClick(token) {
    this.#assertHealthy();
    const entry = this.#recordTrackingSignal(token, 'click', 'click_observed');
    return { target: entry.target };
  }

  unsubscribe(token) {
    this.#assertHealthy();
    const entry = this.store.trackingTokens.get(token);
    if (!entry || entry.type !== 'unsubscribe') notFound();
    const context = { tenantId: entry.tenantId, businessId: entry.businessId, actorId: 'public-unsubscribe', permissions: ['*'] };
    const key = scopedId(context, entry.recipientId);
    if (this.store.suppressions.get(key)?.reason === 'UNSUBSCRIBED') return { status: 'unsubscribed', alreadyUnsubscribed: true };
    this.store.suppressions.set(key, { recipientId: entry.recipientId, reason: 'UNSUBSCRIBED', source: 'EMAILMAR', createdAt: isoNow(this.clock) });
    this.#recordSignal(context, entry.recipientId, 'unsubscribed', { campaignId: entry.campaignId });
    this.#audit(context, 'recipient.unsubscribed', 'recipient', entry.recipientId, { campaignId: entry.campaignId });
    return { status: 'unsubscribed' };
  }

  #recordTrackingSignal(token, expectedType, signal) {
    this.#assertHealthy();
    const entry = this.store.trackingTokens.get(token);
    if (!entry || entry.type !== expectedType) notFound();
    const context = { tenantId: entry.tenantId, businessId: entry.businessId, actorId: 'public-tracking-token', permissions: ['campaign.track'] };
    this.#recordSignal(context, entry.recipientId, signal, { campaignId: entry.campaignId });
    return entry;
  }

  #recordSignal(context, recipientId, type, details) {
    const event = { type, recipientId, at: isoNow(this.clock), ...copy(details) };
    const recipientKey = scopedId(context, recipientId);
    const recipientHistory = this.store.recipientSignals.get(recipientKey) ?? [];
    recipientHistory.push(event);
    this.store.recipientSignals.set(recipientKey, recipientHistory);
    const candidates = details.campaignId ? [this.store.campaigns.get(details.campaignId)].filter(Boolean) : this.store.campaigns.values();
    for (const campaign of candidates) {
      if (campaign.tenantId === context.tenantId && campaign.businessId === context.businessId && campaign.draft.recipientIds.includes(recipientId)) {
        campaign.signals.push(event);
      }
    }
    if (['reply_received', 'bounce_detected', 'unsubscribed'].includes(type)) this.#haltAutomations(context, recipientId, type);
    this.#audit(context, `signal.${type}`, 'recipient', recipientId, details);
    return event;
  }

  recordReply(context, recipientId) {
    requirePermission(context, 'crm.signal.write');
    this.#assertHealthy();
    this.#recipient(context, recipientId);
    return this.#recordSignal(context, recipientId, 'reply_received', { source: 'CRM' });
  }

  recordHardBounce(context, recipientId) {
    requirePermission(context, 'crm.signal.write');
    this.#assertHealthy();
    this.#recipient(context, recipientId);
    this.store.suppressions.set(scopedId(context, recipientId), { recipientId, reason: 'HARD_BOUNCE', source: 'GMAIL_RECONCILIATION', createdAt: isoNow(this.clock) });
    return this.#recordSignal(context, recipientId, 'bounce_detected', { source: 'GMAIL_RECONCILIATION' });
  }

  createFollowUpWorkflow(context, { recipientId, plan }) {
    requirePermission(context, 'workflow.write');
    this.#assertHealthy();
    this.#recipient(context, recipientId);
    if (!Array.isArray(plan) || plan.length === 0) fail('INVALID_WORKFLOW', 'Follow-up plan must contain at least one step.');
    const workflow = {
      id: this.idFactory(), tenantId: context.tenantId, businessId: context.businessId,
      recipientId, plan: copy(plan), status: 'scheduled', pauseReason: null,
      createdAt: isoNow(this.clock), updatedAt: isoNow(this.clock),
    };
    const prior = this.store.recipientSignals.get(scopedId(context, recipientId)) ?? [];
    const priorStopSignal = prior
      .find((signal) => signal.recipientId === recipientId && ['reply_received', 'bounce_detected', 'unsubscribed'].includes(signal.type));
    if (priorStopSignal) {
      workflow.status = 'paused';
      workflow.pauseReason = priorStopSignal.type;
    }
    this.store.automations.set(workflow.id, workflow);
    this.#audit(context, 'automation.created', 'automation', workflow.id, { stepCount: workflow.plan.length, status: workflow.status });
    return copy(workflow);
  }

  getCampaignReport(context, campaignId) {
    requirePermission(context, 'campaign.read');
    this.#assertHealthy();
    const campaign = this.#campaign(context, campaignId);
    const jobs = campaign.queueIds.map((key) => this.store.queue.get(key)).filter(Boolean);
    const countSignals = (type) => campaign.signals.filter((signal) => signal.type === type).length;
    return {
      campaignId,
      status: campaign.status,
      approval: campaign.approval ? { payloadHash: campaign.approval.payloadHash, approvedAt: campaign.approval.approvedAt, approvedBy: campaign.approval.approvedBy } : null,
      queue: jobs.map((job) => ({ id: job.id, recipientId: job.recipientId, status: job.status, scheduledAt: job.scheduledAt, completedAt: job.completedAt, errorCode: job.errorCode })),
      withheldRecipients: copy(campaign.blockedRecipients),
      signals: {
        accepted_by_gmail: countSignals('accepted_by_gmail'),
        delivery_unknown: countSignals('delivery_unknown'),
        open_signal: { count: countSignals('open_signal'), interpretation: 'An image request was observed; this is not proof that a human read the email.' },
        click_observed: countSignals('click_observed'),
        reply_received: countSignals('reply_received'),
        bounce_detected: countSignals('bounce_detected'),
        unsubscribed: countSignals('unsubscribed'),
      },
      humanReadClaim: false,
    };
  }

  getWorkspace(context) {
    for (const permission of ['campaign.read', 'template.read', 'crm.read', 'files.read']) requirePermission(context, permission);
    this.#assertHealthy();
    const prefix = scopedId(context, '');
    const scopedValues = (map) => [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => copy(value));
    const campaigns = [...this.store.campaigns.values()]
      .filter((item) => item.tenantId === context.tenantId && item.businessId === context.businessId)
      .map((item) => ({ ...this.getCampaign(context, item.id), report: this.getCampaignReport(context, item.id) }))
      .reverse();
    const recipients = scopedValues(this.store.recipients).map((recipient) => ({
      ...recipient, ...this.#eligibility(context, recipient),
      suppression: copy(this.store.suppressions.get(scopedId(context, recipient.id)) ?? null),
    }));
    return {
      campaigns, recipients, templates: scopedValues(this.store.templates), attachments: scopedValues(this.store.attachments),
      audit: this.store.audit.filter((event) => event.tenantId === context.tenantId && event.businessId === context.businessId).slice(-50).reverse().map(copy),
      health: this.getHealth(), scope: { tenantId: context.tenantId, businessId: context.businessId },
    };
  }

  dispatchCampaign(context, campaignId) {
    requirePermission(context, 'campaign.worker');
    this.#assertHealthy();
    if (context.actorType !== 'human') fail('HUMAN_DISPATCH_REQUIRED', 'A human must start dispatch from the local interface.', 403);
    const campaign = this.#campaign(context, campaignId);
    if (!this.gmail || typeof this.gmail.send !== 'function') fail('GMAIL_NOT_CONFIGURED', 'Configure a Gmail adapter before dispatching.', 503);
    if (campaign.approval?.snapshot.attachments.length && !this.files?.resolveBytes) fail('FILES_NOT_CONFIGURED', 'Configure a Files resolver before dispatching attachments.', 503);
    return this.dispatchDue(context, { campaignId });
  }

  getHealth() {
    this.#assertHealthy();
    return {
      status: 'ok',
      service: 'emar',
      version: '0.3.0-beta.0',
      persistence: this.store.persistence ?? 'in_memory',
      gmail: this.gmail ? 'adapter_injected' : 'NOT_CONFIGURED',
      files: this.files ? 'adapter_injected' : 'NOT_CONFIGURED',
      dailyLimit: this.dailyLimit,
      authentication: 'host_authorizer_required',
    };
  }
}

export { EmailMarService as EmarService };
