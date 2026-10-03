import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { createDemoApi } from '../src/ui/demo.mjs';
import { createEmailMarServer } from '../src/http/server.mjs';
import { EmailMarService } from '../src/domain/emailmar-service.mjs';

function jsonResponse(value, status = 200) {
  return { ok: status < 400, status, async json() { return value; } };
}

function createElement(selector) {
  const attributes = new Map();
  const classes = new Set();
  return {
    selector,
    id: selector.startsWith('#') ? selector.slice(1) : '',
    dataset: {},
    hidden: false,
    disabled: false,
    isConnected: true,
    checked: false,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    open: false,
    closeCount: 0,
    src: '',
    srcdoc: '',
    classList: {
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
      contains(name) { return classes.has(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    },
    addEventListener(name, listener) { this.listeners ??= new Map(); this.listeners.set(name, listener); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest(selectorName) { return selectorName === '[data-action]' && this.dataset.action ? this : null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    replaceChildren() { this.innerHTML = ''; this.replaceCount = (this.replaceCount ?? 0) + 1; },
    showModal() { this.open = true; },
    close() { this.open = false; this.closeCount += 1; },
  };
}

function createTemplateElement() {
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const fragment = { children: [] };
  const descendants = () => {
    const found = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (child.localName) found.push(child);
        visit(child);
      }
    };
    visit(fragment);
    return found;
  };
  fragment.querySelectorAll = (selector) => {
    const selectors = selector.split(',').map((value) => value.trim().toLowerCase());
    return descendants().filter((element) => selectors.includes('*') || selectors.includes(element.localName));
  };
  const parse = (html) => {
    fragment.children = [];
    const stack = [fragment];
    const tokens = String(html).match(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>|[^<]+|</gi) ?? [];
    for (const token of tokens) {
      if (token.startsWith('<!--')) continue;
      const closing = token.match(/^<\/([a-z][\w:-]*)\s*>$/i);
      if (closing) {
        const name = closing[1].toLowerCase();
        for (let index = stack.length - 1; index > 0; index -= 1) {
          if (stack[index].localName === name) { stack.length = index; break; }
        }
        continue;
      }
      const opening = token.match(/^<([a-z][\w:-]*)([\s\S]*?)\s*\/?>$/i);
      if (opening) {
        const localName = opening[1].toLowerCase();
        const attributes = new Map();
        const rawAttributes = opening[2].replace(/\/\s*$/, '');
        for (const match of rawAttributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
          attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
        }
        const parent = stack.at(-1);
        const element = {
          localName,
          children: [],
          parent,
          get attributes() { return [...attributes].map(([name, value]) => ({ name, value })); },
          setAttribute(name, value) { attributes.set(name.toLowerCase(), String(value)); },
          removeAttribute(name) { attributes.delete(name.toLowerCase()); },
          remove() { const index = parent.children.indexOf(element); if (index >= 0) parent.children.splice(index, 1); },
        };
        parent.children.push(element);
        if (!voidElements.has(localName) && !token.endsWith('/>')) stack.push(element);
        continue;
      }
      stack.at(-1).children.push({ text: token, children: [] });
    }
  };
  const serialize = (node) => (node.children ?? []).map((child) => {
    if (!child.localName) return child.text;
    const attrs = child.attributes.map(({ name, value }) => ` ${name}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join('');
    return voidElements.has(child.localName)
      ? `<${child.localName}${attrs}>`
      : `<${child.localName}${attrs}>${serialize(child)}</${child.localName}>`;
  }).join('');
  return {
    content: fragment,
    get innerHTML() { return serialize(fragment); },
    set innerHTML(value) { parse(value); },
  };
}

function createBrowserFixture() {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const assignedUrls = [];
  const pageNodeMarkers = new Map([
    ['#preview-recipient', 'id="preview-recipient"'],
    ['#email-preview', 'id="email-preview"'],
    ['#reviewed', 'id="reviewed"'],
    ['[data-action="approve"]', 'data-action="approve"'],
    ['.preview-header strong', '<strong>'],
    ['.plain-preview', 'class="plain-preview"'],
  ]);
  let mainHtml = '';
  let hash = '#campaigns';
  const main = createElement('#main');
  Object.defineProperty(main, 'innerHTML', {
    get() { return mainHtml; },
    set(value) {
      mainHtml = String(value);
      for (const selector of pageNodeMarkers.keys()) {
        const previous = elements.get(selector);
        if (previous) previous.isConnected = false;
        elements.delete(selector);
      }
    },
  });
  const document = {
    body: createElement('body'),
    querySelector(selector) {
      if (selector === '#main') return main;
      const marker = pageNodeMarkers.get(selector);
      if (marker && !mainHtml.includes(marker)) return null;
      if (!elements.has(selector)) elements.set(selector, createElement(selector));
      return elements.get(selector);
    },
    createElement(name) { return name.toLowerCase() === 'template' ? createTemplateElement() : createElement(name); },
    querySelectorAll() { return []; },
    addEventListener(name, listener) { documentListeners.set(name, listener); },
  };
  const location = {
    get hash() { return hash; },
    set hash(value) { hash = String(value).startsWith('#') ? String(value) : `#${value}`; },
    assign(url) { assignedUrls.push(String(url)); },
  };
  const window = {
    location,
    addEventListener(name, listener) { windowListeners.set(name, listener); },
  };
  return {
    document,
    window,
    location,
    assignedUrls,
    get(selector) { return document.querySelector(selector); },
    async click(action, data = {}) {
      const target = { dataset: { action, ...data }, disabled: false, isConnected: true };
      target.closest = (selector) => selector === '[data-action]' ? target : null;
      await documentListeners.get('click')({ target, preventDefault() {} });
      return target;
    },
    async hashchange(value) {
      if (value !== undefined) location.hash = value;
      windowListeners.get('hashchange')?.();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
    dispatchChange(target) { return documentListeners.get('change')({ target }); },
  };
}

async function loadAppFixture(fetchImpl) {
  const browser = createBrowserFixture();
  const globals = ['document', 'window', 'location', 'fetch', 'crypto', 'setTimeout', 'clearTimeout'];
  const prior = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    document: { value: browser.document, configurable: true, writable: true },
    window: { value: browser.window, configurable: true, writable: true },
    location: { value: browser.location, configurable: true, writable: true },
    fetch: { value: fetchImpl, configurable: true, writable: true },
    crypto: { value: webcrypto, configurable: true, writable: true },
    setTimeout: { value: () => 1, configurable: true, writable: true },
    clearTimeout: { value: () => {}, configurable: true, writable: true },
  });
  try {
    const appUrl = new URL('../src/ui/app.mjs', import.meta.url);
    appUrl.searchParams.set('fixture', randomUUID());
    await import(appUrl.href);
    return {
      browser,
      restore() {
        for (const name of globals) {
          const descriptor = prior.get(name);
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else delete globalThis[name];
        }
      },
    };
  } catch (error) {
    for (const name of globals) {
      const descriptor = prior.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    throw error;
  }
}

test('demo module is served as a same-origin JavaScript module', async () => {
  const service = new EmailMarService();
  const server = createEmailMarServer({ service, standalone: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-action="demo-toggle"/);
    const module = await fetch(`${base}/ui/demo.mjs`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.match(module.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await module.text(), /export function createDemoApi\(\)/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('demo Gmail and dispatch actions stay in the local fixture API', async () => {
  const originalFetch = globalThis.fetch;
  const attemptedNetwork = [];
  globalThis.fetch = async (...args) => { attemptedNetwork.push(args); throw new Error('Network is forbidden in demo mode.'); };
  try {
    const demo = createDemoApi();
    const connected = await demo.request('/v1/integrations/gmail/connect', {}, 'POST');
    assert.equal(connected.simulation, 'demo-only');
    assert.equal(connected.authorizationUrl, '#settings');
    const dispatched = await demo.request('/v1/campaigns/campaign-workshop/dispatch', {}, 'POST');
    assert.equal(dispatched.simulation, 'demo-only');
    assert.ok(dispatched.outcomes.every((outcome) => outcome.simulation === 'demo-only'));
    assert.deepEqual(attemptedNetwork, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mode switch discards stale responses, suppresses demo network and closes open dialogs', async () => {
  const backend = createDemoApi();
  const calls = [];
  const adversarialPreviewHtml = '<p>Safe link text <a href="https://outside.example/path" xlink:href="https://outside.example/vector" ping="https://tracker.example/p" target="_blank" onclick="window.fixtureNavigation=true">Keep this readable</a></p><area href="https://outside.example/area" ping="https://tracker.example/area" target="_top"><meta http-equiv="refresh" content="0;url=https://outside.example/refresh"><base href="https://outside.example/"><script>window.fixtureNavigation=true</script>';
  let holdNextPreview = false;
  let resolvePreview;
  let previewStarted;
  const previewEntered = new Promise((resolve) => { previewStarted = resolve; });
  const fetchImpl = async (path, init = {}) => {
    const pathname = new URL(String(path), 'http://fixture.local').pathname;
    calls.push(pathname);
    if (pathname === '/ui/session') return jsonResponse({ csrfToken: 'fixture-csrf' });
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (holdNextPreview && pathname.endsWith('/preview')) {
      holdNextPreview = false;
      previewStarted();
      return new Promise((resolve) => { resolvePreview = resolve; });
    }
    try {
      const result = await backend.request(pathname, body, method);
      if (pathname.endsWith('/preview')) result.sample.html = adversarialPreviewHtml;
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ error: { code: error.code ?? 'FIXTURE_ERROR', message: error.message } }, error.status ?? 400);
    }
  };

  const app = await loadAppFixture(fetchImpl);
  try {
    const { browser } = app;
    const initialRequestCount = calls.length;
    holdNextPreview = true;
    const detailPending = browser.hashchange('#campaign/campaign-songkran');
    await previewEntered;

    await browser.click('demo-toggle');
    assert.equal(browser.document.body.classList.contains('demo-mode'), true);
    const callsAfterModeSwitch = calls.length;
    await browser.click('gmail-connect');
    assert.deepEqual(browser.assignedUrls, []);
    assert.equal(calls.length, callsAfterModeSwitch);
    assert.ok(callsAfterModeSwitch > initialRequestCount);

    const preview = await backend.request('/v1/campaigns/campaign-songkran/preview', {}, 'POST');
    resolvePreview(jsonResponse({ ...preview, sample: { ...preview.sample, html: '<p>STALE BACKEND RESULT</p>' } }));
    await detailPending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(browser.document.body.classList.contains('demo-mode'), true);
    assert.equal(browser.get('#main').innerHTML.includes('STALE BACKEND RESULT'), false);
    assert.match(browser.get('#main').innerHTML, /กำลังดูข้อมูลตัวอย่าง/);
    assert.equal(calls.length, callsAfterModeSwitch);

    await browser.hashchange('#campaign/campaign-songkran');
    const main = browser.get('#main').innerHTML;
    assert.match(main, /<iframe id="email-preview"/);
    assert.match(main, /<input id="reviewed" type="checkbox"/);
    assert.match(main, /data-action="approve"/);
    const approve = browser.get('[data-action="approve"]');
    browser.dispatchChange({ id: 'reviewed', checked: true });
    assert.equal(approve.disabled, false);

    await browser.click('gmail-disconnect');
    const dialog = browser.get('#dialog');
    assert.equal(dialog.open, true);
    const previousCloseCount = dialog.closeCount;
    await browser.click('demo-toggle');
    assert.equal(dialog.open, false);
    assert.equal(dialog.closeCount, previousCloseCount + 1);
    assert.equal(browser.document.body.classList.contains('demo-mode'), false);

    await browser.hashchange('#campaign/campaign-songkran');
    const srcdoc = browser.get('#email-preview').srcdoc;
    assert.match(srcdoc, /Keep this readable/);
    assert.doesNotMatch(srcdoc, /https:\/\/(?:outside|tracker)\.example/i);
    assert.doesNotMatch(srcdoc, /\s(?:href|xlink:href|ping|target|onclick)\s*=/i);
    assert.doesNotMatch(srcdoc, /<\s*(?:base|script|meta\s+http-equiv="refresh")\b/i);
    assert.match(srcdoc, /<area aria-disabled="true">/i);
    assert.match(srcdoc, /aria-disabled="true"/);
  } finally {
    app.restore();
  }
});

test('recipient preview responses cannot overwrite a newer campaign or recipient selection', async () => {
  const backend = createDemoApi();
  const gates = new Map();
  const fetchImpl = async (path, init = {}) => {
    const pathname = new URL(String(path), 'http://fixture.local').pathname;
    if (pathname === '/ui/session') return jsonResponse({ csrfToken: 'fixture-csrf' });
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    try {
      const result = await backend.request(pathname, body, method);
      const match = pathname.match(/^\/v1\/campaigns\/([^/]+)\/preview$/);
      if (match) {
        const campaignId = decodeURIComponent(match[1]);
        const marker = `PREVIEW-${campaignId}-${body?.recipientId ?? 'default'}`;
        result.sample = { ...result.sample, subject: marker, plainText: marker, html: `<p>${marker}</p>` };
        const gate = body?.recipientId ? gates.get(body.recipientId) : null;
        if (gate) {
          gate.markStarted();
          return new Promise((resolve) => { gate.release = () => resolve(jsonResponse(result)); });
        }
      }
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ error: { code: error.code ?? 'FIXTURE_ERROR', message: error.message } }, error.status ?? 400);
    }
  };
  const gatePreview = (recipientId) => {
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = { started, markStarted, release: undefined };
    gates.set(recipientId, gate);
    return gate;
  };

  const app = await loadAppFixture(fetchImpl);
  try {
    const { browser } = app;
    await browser.hashchange('#campaign/campaign-songkran');
    const slowAcrossNavigation = gatePreview('recipient-dao');
    const firstSelect = browser.get('#preview-recipient');
    firstSelect.value = 'recipient-dao';
    const firstChange = browser.dispatchChange(firstSelect);
    await slowAcrossNavigation.started;

    await browser.hashchange('#campaign/campaign-workshop');
    assert.match(browser.get('#email-preview').srcdoc, /PREVIEW-campaign-workshop-default/);
    slowAcrossNavigation.release();
    await firstChange;
    assert.match(browser.get('#email-preview').srcdoc, /PREVIEW-campaign-workshop-default/);
    assert.doesNotMatch(browser.get('#email-preview').srcdoc, /PREVIEW-campaign-songkran-recipient-dao/);

    await browser.hashchange('#campaign/campaign-songkran');
    const olderSelection = gatePreview('recipient-dao');
    const oldSelect = browser.get('#preview-recipient');
    oldSelect.value = 'recipient-dao';
    const oldChange = browser.dispatchChange(oldSelect);
    await olderSelection.started;

    const latestSelection = gatePreview('recipient-pim');
    const latestSelect = browser.get('#preview-recipient');
    latestSelect.value = 'recipient-pim';
    const latestChange = browser.dispatchChange(latestSelect);
    await latestSelection.started;
    latestSelection.release();
    await latestChange;
    assert.match(browser.get('#email-preview').srcdoc, /PREVIEW-campaign-songkran-recipient-pim/);

    olderSelection.release();
    await oldChange;
    assert.match(browser.get('#email-preview').srcdoc, /PREVIEW-campaign-songkran-recipient-pim/);
    assert.doesNotMatch(browser.get('#email-preview').srcdoc, /PREVIEW-campaign-songkran-recipient-dao/);
  } finally {
    app.restore();
  }
});
