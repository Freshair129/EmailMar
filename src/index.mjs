import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EmailMarService } from './domain/emailmar-service.mjs';
import { InMemoryStore, SqliteStore } from './domain/store.mjs';
import { ExecutionDagService } from './domain/execution-dag.mjs';
import { GmailConnections } from './integrations/gmail-oauth.mjs';
import { createGmailApiAdapter } from './adapters/gmail-api.mjs';
import { createEmarServer } from './http/server.mjs';
import { LOCAL_CONTEXT } from './http/local-session.mjs';

const env = process.env;
const port = Number(env.PORT ?? 8788);
const host = env.HOST ?? '127.0.0.1';
const dailyLimit = Number(env.EMAR_DAILY_LIMIT ?? env.EMAILMAR_DAILY_LIMIT ?? 500);
const publicBaseUrl = env.EMAR_PUBLIC_BASE_URL ?? env.EMAILMAR_PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const storageMode = env.EMAR_STORAGE ?? env.EMAILMAR_STORAGE ?? 'sqlite';
const gmailRedirectUri = env.EMAR_GOOGLE_REDIRECT_URI ?? `http://127.0.0.1:${port}/v1/integrations/gmail/callback`;
const store = storageMode === 'memory'
  ? new InMemoryStore()
  : storageMode === 'sqlite'
    ? new SqliteStore({ path: env.EMAR_DATABASE_PATH ?? env.EMAILMAR_DATABASE_PATH ?? resolve('data/emar.sqlite') })
    : (() => { throw new Error('EMAR_STORAGE must be "sqlite" or explicitly "memory".'); })();

const service = new EmailMarService({ store, dailyLimit, publicBaseUrl });
const executionDag = new ExecutionDagService({ store });
const gmailConnections = GmailConnections.fromEnvironment({ store, env: { ...env, EMAR_GOOGLE_REDIRECT_URI: gmailRedirectUri } });
const gmailStatus = await gmailConnections.status(LOCAL_CONTEXT);
const gmailApi = createGmailApiAdapter({
  getAccessToken: (request) => gmailConnections.getAccessToken(request),
  connectionIdentity: (request) => gmailConnections.connectionIdentity(request),
});
service.gmail = gmailStatus.status === 'NOT_CONFIGURED' ? null : gmailApi;

let ownerAdapters = {};
const adapterModulePath = env.EMAR_ADAPTER_MODULE ?? env.EMAILMAR_ADAPTER_MODULE;
if (adapterModulePath) {
  const moduleUrl = pathToFileURL(resolve(adapterModulePath)).href;
  const adapterModule = await import(moduleUrl);
  if (typeof adapterModule.createEmailMarAdapters !== 'function') {
    throw new TypeError('EMAILMAR_ADAPTER_MODULE must export createEmailMarAdapters({ service, createGmailApiAdapter }).');
  }
  ownerAdapters = await adapterModule.createEmailMarAdapters({ service, createGmailApiAdapter });
  if (!ownerAdapters || typeof ownerAdapters !== 'object') throw new TypeError('createEmailMarAdapters must return an adapter object.');
  service.gmail = ownerAdapters.gmail ?? service.gmail;
  service.files = ownerAdapters.files ?? null;
}

const standalone = typeof ownerAdapters.authorizeRequest !== 'function';
if (standalone && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Standalone UI requires a loopback HOST (127.0.0.1, localhost, or ::1).');
const server = createEmarServer({
  service,
  authorizeRequest: ownerAdapters.authorizeRequest ?? (async () => null),
  standalone,
  gmailConnections,
  gmailRedirectUri,
  executionDag,
});

server.listen(port, host, () => {
  process.stdout.write(`Emar UI: http://${host}:${port}/ (${standalone ? 'standalone local operator' : 'external identity'}; ${store.persistence} storage).\n`);
});

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.close(() => {
    try {
      store.checkpoint();
    } catch {
      process.stderr.write(`Emar: durable storage checkpoint failed during ${signal}.\n`);
      process.exitCode = 1;
    }
    try {
      store.close();
    } catch {
      process.stderr.write(`Emar: durable storage close failed during ${signal}.\n`);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
