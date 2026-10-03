import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { EmailMarError, requirePermission } from '../domain/errors.mjs';
import { LocalSessions, assertLocalRequest, assertLocalCallbackRequest } from './local-session.mjs';
import { serveUi } from './ui-assets.mjs';

const MAX_BODY_BYTES = 1_048_576;
const MCP_PROTOCOL_VERSION = '2024-11-05';
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const GMAIL_CALLBACK = '/v1/integrations/gmail/callback';
const GMAIL_BINDING_COOKIE = 'emar_gmail_oauth';
const GMAIL_BINDING_TTL_SECONDS = 600;

const MCP_TOOLS = [
  {
    name: 'create_campaign_draft',
    description: 'Create a tenant and business scoped email campaign draft. This does not approve or send email.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['name', 'templateId', 'templateVersion', 'recipientIds'],
      properties: {
        name: { type: 'string' }, templateId: { type: 'string' }, templateVersion: { type: 'integer' },
        recipientIds: { type: 'array', items: { type: 'string' } },
        recipientVariables: { type: 'object' }, attachmentIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'preview_campaign',
    description: 'Preview a campaign draft and current consent/suppression eligibility.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['campaignId'], properties: { campaignId: { type: 'string' }, recipientId: { type: 'string' }, draftHash: { type: 'string' } } },
  },
  {
    name: 'schedule_approved_campaign',
    description: 'Schedule a campaign only after a human has approved its current immutable snapshot.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['campaignId'], properties: { campaignId: { type: 'string' }, scheduledAt: { type: 'string', format: 'date-time' } } },
  },
  {
    name: 'pause_campaign',
    description: 'Pause a campaign and cancel queue entries that have not started.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['campaignId'], properties: { campaignId: { type: 'string' } } },
  },
  {
    name: 'get_campaign_report',
    description: 'Read scoped campaign queue and event signals; an open signal is not proof of a human read.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['campaignId'], properties: { campaignId: { type: 'string' } } },
  },
];

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new EmailMarError('BODY_TOO_LARGE', 'Request body exceeds 1 MiB.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new EmailMarError('BODY_TOO_LARGE', 'Request body exceeds 1 MiB.', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new EmailMarError('INVALID_JSON', 'Request body must be valid JSON.', 400);
  }
}

async function readText(request) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new EmailMarError('BODY_TOO_LARGE', 'Request body exceeds 1 MiB.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new EmailMarError('BODY_TOO_LARGE', 'Request body exceeds 1 MiB.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requireKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EmailMarError('INVALID_INPUT', 'Request body must be a JSON object.', 400);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new EmailMarError('INVALID_INPUT', `Unexpected field: ${key}.`, 400);
  }
}

async function dispatchTool(service, context, name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new EmailMarError('INVALID_INPUT', 'Tool arguments must be an object.', 400);
  switch (name) {
    case 'create_campaign_draft':
      requireKeys(args, ['name', 'templateId', 'templateVersion', 'recipientIds', 'recipientVariables', 'attachmentIds']);
      return service.createCampaignDraft(context, args);
    case 'preview_campaign':
      requireKeys(args, ['campaignId', 'recipientId', 'draftHash']);
      return service.previewCampaign(context, args.campaignId, args);
    case 'schedule_approved_campaign':
      requireKeys(args, ['campaignId', 'scheduledAt']);
      return service.scheduleCampaign(context, args.campaignId, args);
    case 'pause_campaign':
      requireKeys(args, ['campaignId']);
      return service.pauseCampaign(context, args.campaignId);
    case 'get_campaign_report':
      requireKeys(args, ['campaignId']);
      return service.getCampaignReport(context, args.campaignId);
    default:
      throw new EmailMarError('UNKNOWN_TOOL', `Unknown tool: ${name}.`, 404);
  }
}

async function handleMcp(request, response, service, context) {
  if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP accepts POST.' } }, { allow: 'POST' });
  const packet = await readJson(request);
  const id = packet?.id ?? null;
  if (packet?.jsonrpc !== '2.0' || typeof packet.method !== 'string') {
    return json(response, 400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }
  if (packet.method === 'initialize') {
    return json(response, 200, {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'emar', version: '0.3.0-beta.0' },
      },
    });
  }
  if (packet.method === 'notifications/initialized') {
    response.writeHead(202);
    return response.end();
  }
  if (packet.method === 'tools/list') return json(response, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
  if (packet.method === 'tools/call') {
    try {
      const result = await dispatchTool(service, context, packet.params?.name, packet.params?.arguments ?? {});
      return json(response, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } });
    } catch (error) {
      const body = { code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? 'Internal error.' };
      return json(response, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true } });
    }
  }
  return json(response, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

function errorResponse(response, error) {
  if (response.headersSent) return response.end();
  const status = Number.isInteger(error?.status) ? error.status : 500;
  json(response, status, { error: { code: error?.code ?? 'INTERNAL_ERROR', message: status >= 500 ? 'Request failed.' : error.message } });
}

function cookieValue(request, name) {
  return String(request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

function gmailBindingCookie(request, binding, clear = false) {
  const secure = request.socket.encrypted ? '; Secure' : '';
  const lifetime = clear ? 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : `Max-Age=${GMAIL_BINDING_TTL_SECONDS}`;
  return `${GMAIL_BINDING_COOKIE}=${binding}; HttpOnly; SameSite=Lax; Path=${GMAIL_CALLBACK}; ${lifetime}${secure}`;
}

function localHuman(context, permission) {
  requirePermission(context, permission);
  if (context.actorType !== 'human') throw new EmailMarError('HUMAN_REQUIRED', 'An authenticated human is required for this action.', 403);
}

function requireDag(executionDag) {
  if (!executionDag) throw new EmailMarError('DAG_NOT_CONFIGURED', 'Execution DAG storage is not configured.', 503);
  return executionDag;
}

export function createEmailMarServer({ service, authorizeRequest = async () => null, standalone = false, gmailConnections = null, gmailRedirectUri = null, executionDag = null } = {}) {
  if (!service || typeof authorizeRequest !== 'function') throw new TypeError('Service and request authorizer are required.');
  const sessions = standalone ? new LocalSessions() : null;
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://emailmar.local');
      if (request.method === 'GET' && ['/', '/ui/app.mjs', '/ui/demo.mjs', '/ui/styles.css', '/ui/dags.css'].includes(url.pathname)) {
        if (standalone) assertLocalRequest(request, false, url.pathname === '/' && !url.search);
        await serveUi(url.pathname, response);
        return;
      }
      if (url.pathname === GMAIL_CALLBACK && request.method === 'GET') {
        const expectedOrigin = gmailConnections?.callbackOrigin ?? (gmailRedirectUri ? new URL(gmailRedirectUri).origin : null);
        assertLocalCallbackRequest(request, expectedOrigin);
        const sessionBinding = cookieValue(request, GMAIL_BINDING_COOKIE);
        let outcome = 'failed';
        try {
          if (gmailConnections) {
            const result = await gmailConnections.complete({
              state: url.searchParams.get('state') ?? '',
              code: url.searchParams.get('code') ?? '',
              error: url.searchParams.get('error') ?? null,
              sessionBinding,
            });
            if (result?.outcome === 'CANCELLED') outcome = 'cancelled';
            else if (result?.status === 'CONNECTED') outcome = 'connected';
          }
        } catch {
          // Provider callback details stay in the server-owned integration state.
        }
        response.writeHead(303, {
          location: `/#settings/callback-${outcome}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'set-cookie': gmailBindingCookie(request, '', true),
        });
        return response.end();
      }
      if (url.pathname === GMAIL_CALLBACK && request.method !== 'GET') {
        return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'OAuth callback accepts GET.' } }, { allow: 'GET' });
      }
      if (url.pathname === '/ui/session' && request.method === 'POST') {
        if (!sessions) throw new EmailMarError('STANDALONE_DISABLED', 'Standalone mode is disabled while an external Identity authorizer is configured.', 403);
        return json(response, 200, sessions.open(request, response));
      }
      if (url.pathname === '/ui/logout' && request.method === 'POST' && sessions) {
        sessions.close(request, response);
        return json(response, 200, { status: 'signed_out' });
      }
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ...service.getHealth(), authentication: standalone ? 'local_session' : 'host_authorizer_required' });

      const open = url.pathname.match(/^\/v1\/tracking\/open\/([\w-]+)\.gif$/);
      if (request.method === 'GET' && open) {
        service.recordOpen(open[1]);
        response.writeHead(200, { 'content-type': 'image/gif', 'content-length': PIXEL.length, 'cache-control': 'no-store, no-cache, must-revalidate' });
        return response.end(PIXEL);
      }
      const click = url.pathname.match(/^\/v1\/tracking\/click\/([\w-]+)$/);
      if (request.method === 'GET' && click) {
        const { target } = service.recordClick(click[1]);
        response.writeHead(302, { location: target, 'cache-control': 'no-store' });
        return response.end();
      }
      const unsubscribe = url.pathname.match(/^\/v1\/tracking\/unsubscribe\/([\w-]+)$/);
      if (unsubscribe && ['GET', 'POST'].includes(request.method)) {
        if (request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return response.end(`<!doctype html><html><head><title>Unsubscribe</title></head><body><p>Confirm that you want to unsubscribe from marketing email.</p><form method="post" action="/v1/tracking/unsubscribe/${unsubscribe[1]}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form></body></html>`);
        }
        const contentType = request.headers['content-type'] ?? '';
        if (contentType.startsWith('application/x-www-form-urlencoded')) {
          const form = new URLSearchParams(await readText(request));
          if (form.get('List-Unsubscribe') !== 'One-Click') throw new EmailMarError('INVALID_UNSUBSCRIBE', 'One-click unsubscribe confirmation is required.', 400);
        } else {
          await readJson(request);
        }
        service.unsubscribe(unsubscribe[1]);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return response.end('<!doctype html><html><head><title>Unsubscribed</title></head><body><p>You have been unsubscribed from marketing email.</p></body></html>');
      }

      const context = await authorizeRequest(request) ?? (sessions && url.pathname !== '/mcp' ? sessions.authorize(request) : null);
      if (!context) throw new EmailMarError('UNAUTHORIZED', 'An authenticated local session or trusted Identity authorizer is required.', 401);
      if (url.pathname === '/mcp') return handleMcp(request, response, service, context);
      if (url.pathname === '/v1/workspace' && request.method === 'GET') return json(response, 200, { ...service.getWorkspace(context), mode: standalone ? 'standalone' : 'integrated' });
      if (url.pathname === '/v1/integrations/gmail/status' && request.method === 'GET') {
        requirePermission(context, 'integration.read');
        if (!gmailConnections) return json(response, 200, { status: 'NOT_CONFIGURED', missingFields: ['EMAR_GOOGLE_CLIENT_ID', 'EMAR_GOOGLE_CLIENT_SECRET', 'EMAR_TOKEN_ENCRYPTION_KEY'], redirectUri: gmailRedirectUri });
        return json(response, 200, { ...await gmailConnections.status(context), redirectUri: gmailRedirectUri });
      }
      if (url.pathname === '/v1/integrations/gmail/connect' && request.method === 'POST') {
        localHuman(context, 'integration.write');
        if (!gmailConnections) throw new EmailMarError('GMAIL_OAUTH_NOT_CONFIGURED', 'Configure the Gmail OAuth fields listed in Settings.', 503);
        let callbackOrigin;
        try {
          const configuredCallback = new URL(gmailRedirectUri);
          if (configuredCallback.pathname !== GMAIL_CALLBACK) throw new Error('callback path mismatch');
          callbackOrigin = configuredCallback.origin;
        } catch {
          throw new EmailMarError('GMAIL_CALLBACK_MISCONFIGURED', 'The configured Gmail callback URL is invalid. Check EMAR_GOOGLE_REDIRECT_URI.', 503);
        }
        if (request.headers.origin !== callbackOrigin) {
          throw new EmailMarError('GMAIL_CALLBACK_ORIGIN_MISMATCH', `Open Emar at ${callbackOrigin} before starting Gmail sign-in.`, 400);
        }
        const body = await readJson(request);
        requireKeys(body, []);
        const sessionBinding = randomBytes(32).toString('hex');
        const started = await gmailConnections.start(context, { sessionBinding });
        let authorization;
        try { authorization = new URL(started.authorizationUrl); } catch { throw new EmailMarError('GMAIL_OAUTH_UNAVAILABLE', 'Gmail authorization could not be started.', 503); }
        if (authorization.protocol !== 'https:' || authorization.hostname !== 'accounts.google.com') {
          throw new EmailMarError('GMAIL_OAUTH_UNAVAILABLE', 'Gmail authorization could not be started.', 503);
        }
        return json(response, 200, { authorizationUrl: authorization.href }, { 'set-cookie': gmailBindingCookie(request, sessionBinding) });
      }
      if (url.pathname === '/v1/integrations/gmail/disconnect' && request.method === 'POST') {
        localHuman(context, 'integration.write');
        if (!gmailConnections) throw new EmailMarError('GMAIL_OAUTH_NOT_CONFIGURED', 'Gmail OAuth is not configured.', 503);
        const callbackOrigin = gmailConnections.callbackOrigin ?? (gmailRedirectUri ? new URL(gmailRedirectUri).origin : null);
        if (!callbackOrigin || request.headers.origin !== callbackOrigin) {
          throw new EmailMarError('GMAIL_CALLBACK_ORIGIN_MISMATCH', `Open Emar at ${callbackOrigin ?? 'the configured callback origin'} before managing Gmail.`, 400);
        }
        const body = await readJson(request);
        requireKeys(body, []);
        return json(response, 200, await gmailConnections.disconnect(context));
      }
      if (url.pathname === '/v1/dags' && request.method === 'GET') {
        requirePermission(context, 'dag.read');
        return json(response, 200, await requireDag(executionDag).list(context));
      }
      if (url.pathname === '/v1/dags' && request.method === 'POST') {
        requirePermission(context, 'dag.write');
        const body = await readJson(request);
        requireKeys(body, ['id', 'nodes']);
        return json(response, 201, await requireDag(executionDag).create(context, body));
      }
      const dagRun = url.pathname.match(/^\/v1\/dags\/([^/]+)(?:\/(pause|resume|nodes\/([^/]+)\/(claim|complete|recover|gate)))?$/);
      if (dagRun) {
        const runId = decodeURIComponent(dagRun[1]);
        const action = dagRun[2];
        if (!action && request.method === 'GET') {
          requirePermission(context, 'dag.read');
          return json(response, 200, await requireDag(executionDag).get(context, runId));
        }
        if (action === 'pause' && request.method === 'POST') {
          localHuman(context, 'dag.write');
          const body = await readJson(request);
          requireKeys(body, ['reason']);
          return json(response, 200, await requireDag(executionDag).pause(context, runId, body.reason));
        }
        if (action === 'resume' && request.method === 'POST') {
          localHuman(context, 'dag.gate');
          const body = await readJson(request);
          requireKeys(body, []);
          return json(response, 200, await requireDag(executionDag).resume(context, runId));
        }
        const nodeId = dagRun[3] ? decodeURIComponent(dagRun[3]) : null;
        const nodeAction = dagRun[4];
        if (nodeAction === 'claim' && request.method === 'POST') {
          requirePermission(context, 'dag.worker');
          const body = await readJson(request);
          requireKeys(body, ['workerId']);
          return json(response, 200, await requireDag(executionDag).claim(context, runId, nodeId, body));
        }
        if (nodeAction === 'complete' && request.method === 'POST') {
          requirePermission(context, 'dag.worker');
          const body = await readJson(request);
          requireKeys(body, ['fencingToken', 'result']);
          return json(response, 200, await requireDag(executionDag).complete(context, runId, nodeId, body));
        }
        if (nodeAction === 'recover' && request.method === 'POST') {
          localHuman(context, 'dag.gate');
          const body = await readJson(request);
          requireKeys(body, []);
          return json(response, 200, await requireDag(executionDag).resumeInterrupted(context, runId, nodeId));
        }
        if (nodeAction === 'gate' && request.method === 'POST') {
          localHuman(context, 'dag.gate');
          const body = await readJson(request);
          requireKeys(body, ['decision']);
          return json(response, 200, await requireDag(executionDag).complete(context, runId, nodeId, { result: { decision: body.decision } }));
        }
      }
      if (url.pathname === '/v1/templates' && request.method === 'POST') {
        const body = await readJson(request);
        requireKeys(body, ['id', 'version', 'subject', 'html', 'plainText', 'variables']);
        return json(response, 201, service.createTemplate(context, body));
      }
      if (url.pathname === '/v1/recipients' && request.method === 'POST') {
        const body = await readJson(request);
        requireKeys(body, ['id', 'email', 'displayName', 'consents']);
        return json(response, 200, service.upsertRecipient(context, body));
      }
      const suppression = url.pathname.match(/^\/v1\/recipients\/([^/]+)\/suppression$/);
      if (suppression && request.method === 'POST') {
        const body = await readJson(request);
        requireKeys(body, ['reason']);
        return json(response, 200, service.syncSuppression(context, decodeURIComponent(suppression[1]), body.reason, context.inputSource ?? 'CRM'));
      }
      if (url.pathname === '/v1/attachments' && request.method === 'POST') {
        const body = await readJson(request);
        requireKeys(body, ['id', 'fileRef', 'sha256', 'filename', 'mimeType', 'size', 'version']);
        return json(response, 201, service.registerAttachment(context, body));
      }
      if (request.method === 'POST' && url.pathname === '/v1/campaigns') {
        const body = await readJson(request);
        requireKeys(body, ['name', 'templateId', 'templateVersion', 'recipientIds', 'recipientVariables', 'attachmentIds']);
        const result = service.createCampaignDraft(context, body);
        return json(response, 201, result);
      }
      const route = url.pathname.match(/^\/v1\/campaigns\/([^/]+)(?:\/(preview|approve|schedule|pause|report|dispatch))?$/);
      if (route) {
        const campaignId = decodeURIComponent(route[1]);
        const action = route[2];
        if (!action && request.method === 'GET') return json(response, 200, service.getCampaign(context, campaignId));
        if (!action && request.method === 'PATCH') {
          const body = await readJson(request);
          requireKeys(body, ['name', 'templateId', 'templateVersion', 'recipientIds', 'recipientVariables', 'attachmentIds']);
          return json(response, 200, service.updateCampaignDraft(context, campaignId, body));
        }
        if (action === 'dispatch' && request.method === 'POST') {
          if (service.gmail?.connectionIdentity && gmailConnections) {
            const connection = await gmailConnections.status(context);
            if (connection.status !== 'CONNECTED') {
              throw new EmailMarError('GMAIL_NOT_CONNECTED', 'Connect a Gmail account in Settings before dispatching; the queue was not changed.', 503);
            }
          }
          return json(response, 200, await service.dispatchCampaign(context, campaignId));
        }
        if (action === 'preview' && request.method === 'POST') {
          const body = await readJson(request);
          requireKeys(body, ['recipientId', 'draftHash']);
          return json(response, 200, service.previewCampaign(context, campaignId, body));
        }
        if (action === 'approve' && request.method === 'POST') {
          const body = await readJson(request);
          requireKeys(body, ['draftHash']);
          return json(response, 200, service.approveCampaign(context, campaignId, body));
        }
        if (action === 'schedule' && request.method === 'POST') {
          const body = await readJson(request);
          requireKeys(body, ['scheduledAt']);
          return json(response, 200, service.scheduleCampaign(context, campaignId, body));
        }
        if (action === 'pause' && request.method === 'POST') return json(response, 200, service.pauseCampaign(context, campaignId));
        if (action === 'report' && request.method === 'GET') return json(response, 200, service.getCampaignReport(context, campaignId));
      }
      return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    })().catch((error) => errorResponse(response, error));
  });
}

export const createEmarServer = createEmailMarServer;
