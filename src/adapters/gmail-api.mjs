import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

export class GmailApiError extends Error {
  constructor(code, message, { safeToRetry = false, status = null, requestStarted = false } = {}) {
    super(message);
    this.name = 'GmailApiError';
    this.code = code;
    this.safeToRetry = safeToRetry;
    this.status = status;
    this.requestStarted = requestStarted;
  }
}

function assertHeader(value, name) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new GmailApiError('INVALID_MESSAGE', `${name} is invalid.`, { safeToRetry: true });
  return value;
}

function base64Lines(value) {
  return Buffer.from(value).toString('base64').replace(/.{1,76}/g, (line) => `${line}${CRLF}`).trimEnd();
}

function encodedWord(value) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function filenameHeader(value) {
  const safe = String(value).replace(/[\r\n"\\]/g, '_').slice(0, 180);
  return `filename="${safe}"`;
}

export function buildRawMessage(message, boundaryFactory = randomUUID) {
  const to = assertHeader(message.to, 'Recipient');
  const from = message.from === undefined ? null : assertHeader(message.from, 'Sender');
  const subject = assertHeader(message.subject, 'Subject');
  const unsubscribeUrl = assertHeader(message.unsubscribeUrl, 'Unsubscribe URL');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw new GmailApiError('INVALID_MESSAGE', 'Recipient email address is invalid.', { safeToRetry: true });
  const headers = [
    `To: ${to}`,
    ...(from ? [`From: ${from}`] : []),
    `Subject: ${encodedWord(subject)}`,
    'MIME-Version: 1.0',
    `List-Unsubscribe: <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  ];
  const alternativeBoundary = `emailmar-alt-${boundaryFactory()}`;
  const body = [
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.plainText),
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.html),
    `--${alternativeBoundary}--`,
  ].join(CRLF);
  let mimeBody = body;
  if (message.attachments?.length) {
    const mixedBoundary = `emailmar-mix-${boundaryFactory()}`;
    mimeBody = [
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      '',
      body,
      ...message.attachments.flatMap((attachment) => {
        const mimeType = assertHeader(attachment.mimeType, 'Attachment MIME type');
        const filename = filenameHeader(attachment.filename);
        return [
          `--${mixedBoundary}`,
          `Content-Type: ${mimeType}; ${filename}`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; ${filename}`,
          '',
          base64Lines(attachment.bytes),
        ];
      }),
      `--${mixedBoundary}--`,
    ].join(CRLF);
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  } else {
    headers.push(`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`);
  }
  const mime = `${headers.join(CRLF)}${CRLF}${CRLF}${mimeBody}`;
  return Buffer.from(mime, 'utf8').toString('base64url');
}

export function createGmailApiAdapter({ getAccessToken, connectionIdentity, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  return {
    connectionIdentity: typeof connectionIdentity === 'function' ? connectionIdentity : undefined,
    async send({ message, tenantId, businessId, expectedConnectionIdentity, beforeRequest }) {
      if (typeof getAccessToken !== 'function') {
        throw new GmailApiError('GMAIL_OAUTH_NOT_CONFIGURED', 'Gmail OAuth token provider is not configured.', { safeToRetry: true });
      }
      let accessToken;
      try {
        accessToken = await getAccessToken({ tenantId, businessId, provider: 'gmail', expectedConnectionIdentity });
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('STORE_')) throw error;
        throw new GmailApiError('GMAIL_TOKEN_UNAVAILABLE', 'Gmail OAuth token is unavailable from the Integration owner.', { safeToRetry: true });
      }
      if (typeof accessToken !== 'string' || !accessToken) {
        throw new GmailApiError('GMAIL_TOKEN_UNAVAILABLE', 'Gmail OAuth token is unavailable from the Integration owner.', { safeToRetry: true });
      }
      let pinnedSender = null;
      if (expectedConnectionIdentity !== undefined) {
        try {
          if (typeof connectionIdentity !== 'function') throw new Error('identity provider unavailable');
          const currentIdentity = connectionIdentity({ tenantId, businessId });
          const sameIdentity = expectedConnectionIdentity && currentIdentity
            && ['connectionId', 'accountId', 'email'].every((key) => expectedConnectionIdentity[key] === currentIdentity[key]);
          if (!sameIdentity) throw new Error('identity changed');
          pinnedSender = assertHeader(expectedConnectionIdentity.email, 'Sender');
        } catch {
          throw new GmailApiError('GMAIL_SENDER_CHANGED', 'The connected Gmail sender changed after this campaign was approved. Recheck and approve the current sender.', { safeToRetry: true });
        }
      }
      const raw = buildRawMessage({ ...message, ...(pinnedSender ? { from: pinnedSender } : {}) });
      if (typeof beforeRequest === 'function') beforeRequest();
      let response;
      try {
        response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
          throw new GmailApiError('GMAIL_SEND_UNKNOWN', 'Gmail request outcome is unknown after the request started.', { requestStarted: true });
      }
      if (!response.ok) {
        if (response.status >= 500) {
          throw new GmailApiError('GMAIL_SEND_UNKNOWN', 'Gmail returned a server error; acceptance cannot be ruled out.', { status: response.status, requestStarted: true });
        }
        throw new GmailApiError('GMAIL_REJECTED', `Gmail rejected the request with HTTP ${response.status}.`, { safeToRetry: true, status: response.status, requestStarted: true });
      }
      let result;
      try {
        result = await response.json();
      } catch {
        throw new GmailApiError('GMAIL_SEND_UNKNOWN', 'Gmail response could not confirm whether the message was accepted.', { status: response.status, requestStarted: true });
      }
      if (typeof result?.id !== 'string' || !result.id) {
        throw new GmailApiError('GMAIL_SEND_UNKNOWN', 'Gmail response did not include a message id confirming acceptance.', { status: response.status, requestStarted: true });
      }
      return { accepted: true, providerMessageId: result.id };
    },
  };
}
