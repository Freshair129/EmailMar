import { createDemoApi } from './demo.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const id = () => crypto.randomUUID();
const date = (value) => value ? new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const number = (value) => Number(value || 0).toLocaleString('th-TH');
const names = { campaigns: 'แคมเปญ', audience: 'ผู้รับและความยินยอม', templates: 'เทมเพลต', files: 'ไฟล์แนบ', activity: 'ประวัติกิจกรรม', dags: 'เวิร์กโฟลว์', settings: 'การเชื่อมต่อและสถานะ' };
const statuses = { draft: ['ฉบับร่าง', ''], approved: ['อนุมัติแล้ว', 'good'], scheduled: ['อยู่ในคิว', 'warm'], paused: ['หยุดชั่วคราว', ''], pending: ['รอส่ง', 'warm'], accepted_by_gmail: ['Gmail รับแล้ว', 'good'], SEND_UNKNOWN: ['ไม่ทราบผลการส่ง', 'bad'], cancelled: ['ยกเลิก', ''], failed: ['ไม่สำเร็จ', 'bad'], NOT_CONFIGURED: ['ยังไม่ตั้งค่า', ''], DISCONNECTED: ['ยังไม่เชื่อมต่อ', ''], REAUTH_REQUIRED: ['ต้องเชื่อมต่อใหม่', 'bad'], CONNECTED: ['เชื่อมต่อแล้ว', 'good'], active: ['พร้อมดำเนินการ', 'warm'], completed: ['เสร็จแล้ว', 'good'], stopped: ['หยุดแล้ว', 'bad'], ready: ['รอ worker', ''], blocked: ['รอขั้นก่อนหน้า', ''], running: ['worker กำลังทำงาน', 'warm'], interrupted: ['ถูกขัดจังหวะ', 'bad'] };
let workspace, gmailStatus, csrf, preview, generation = 0, modeEpoch = 0, previewRequestSequence = 0, toastTimer;
let demoMode = false;
let demoApi = createDemoApi();
const badge = (status) => `<span class="badge ${statuses[status]?.[1] ?? ''}">${esc(statuses[status]?.[0] ?? status)}</span>`;
const button = (text, action, attrs = '', style = '') => `<button class="btn ${style}" data-action="${action}" ${attrs}>${text}</button>`;
const note = () => demoMode
  ? `<div class="notice demo-notice"><span class="demo-badge-inline">DEMO</span><span><strong>กำลังดูข้อมูลตัวอย่าง</strong> · การเปลี่ยนแปลงอยู่ในหน่วยความจำของเดโมนี้ ไม่แตะฐานข้อมูลหรือบัญชีจริง</span><a href="#settings">ดูรายละเอียด ↗</a></div>`
  : `<div class="notice"><span>ⓘ</span><span><strong>พื้นที่ทำงานบนเครื่องนี้</strong> · ${workspace.health.persistence === 'sqlite' ? 'ข้อมูลหลักเก็บถาวรใน SQLite บนเครื่องนี้' : 'โหมดหน่วยความจำชั่วคราว ข้อมูลจะหายเมื่อบริการหยุด'}</span><a href="#settings">ดูสถานะการเชื่อมต่อ ↗</a></div>`;
const empty = (title, description, action = '') => `<div class="empty"><div class="empty-art" aria-hidden="true"><div class="letter"></div><span class="spark">✦</span></div><h2>${title}</h2><p>${description}</p>${action}</div>`;
const head = (title, subtitle, action = '') => `<div class="page-head"><div><div class="eyebrow">YOUR EMAIL STUDIO</div><h1>${title}</h1><p class="sub">${subtitle}</p></div>${action}</div>`;
const panel = (title, body) => `<section class="panel"><div class="panel-head"><h2>${title}</h2></div><div class="panel-body">${body}</div></section>`;
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `toast${error ? ' error-toast' : ''}`; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500); }
function staleModeError() { const error = new Error(''); error.staleMode = true; return error; }
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const requestEpoch = modeEpoch;
  const usingDemo = demoMode;
  try {
    let result;
    if (usingDemo) {
      result = await demoApi.request(path, body, method);
    } else {
      const response = await fetch(path, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      result = await response.json();
      if (!response.ok) throw new Error(`${result.error?.code ?? response.status}: ${result.error?.message ?? 'คำขอไม่สำเร็จ'}`);
    }
    if (requestEpoch !== modeEpoch || usingDemo !== demoMode) throw staleModeError();
    return result;
  } catch (error) {
    if (requestEpoch !== modeEpoch || usingDemo !== demoMode) throw staleModeError();
    throw error;
  }
}
async function refresh() {
  const requestEpoch = modeEpoch;
  try {
    const [nextWorkspace, nextGmailStatus] = await Promise.all([api('/v1/workspace'), api('/v1/integrations/gmail/status')]);
    if (requestEpoch !== modeEpoch) return;
    workspace = nextWorkspace;
    gmailStatus = nextGmailStatus;
    await render(requestEpoch);
  } catch (error) {
    if (requestEpoch !== modeEpoch || error.staleMode) return;
    throw error;
  }
}
function campaignTable(items) {
  return `<div class="table-wrap"><table><thead><tr><th>ชื่อแคมเปญ</th><th>สถานะ</th><th>ผู้รับ</th><th>Gmail รับแล้ว</th><th>อัปเดตล่าสุด</th><th></th></tr></thead><tbody>${items.map((c) => `<tr data-search="${esc(c.name.toLowerCase())}"><td><a class="link" href="#campaign/${encodeURIComponent(c.id)}">${esc(c.name)}</a><small>ฉบับที่ ${c.draftRevision} · เทมเพลต v${c.draft.templateVersion}</small></td><td>${badge(c.status)}</td><td>${number(c.draft.recipientIds.length)} คน</td><td>${number(c.report.signals.accepted_by_gmail)}</td><td class="muted small-text">${date(c.updatedAt)}</td><td><a href="#campaign/${encodeURIComponent(c.id)}" aria-label="เปิด ${esc(c.name)}">↗</a></td></tr>`).join('')}</tbody></table></div>`;
}
function campaignsPage() {
  const all = workspace.campaigns;
  const metrics = [['แคมเปญทั้งหมด', all.length, 'ทุกแคมเปญในพื้นที่นี้', '◈'], ['ผู้รับที่มีสิทธิ์ส่ง', workspace.recipients.filter((r) => r.eligible).length, 'ผ่าน consent และ suppression', '♧'], ['Gmail รับข้อความแล้ว', all.reduce((n, c) => n + c.report.signals.accepted_by_gmail, 0), 'การรับข้อความไม่ยืนยันการนำส่ง', '↗'], ['ฉบับรออนุมัติ', all.filter((c) => c.status === 'draft').length, 'รอการตรวจสอบจากคุณ', '◷']];
  return head('แคมเปญของคุณ', 'เปลี่ยนไอเดียให้เป็นอีเมลที่มีความหมาย ทุกการส่งอยู่ในการดูแลของคุณ', button('<span>＋</span> สร้างแคมเปญ', 'new-campaign', '', 'primary')) + note() + `<div class="stats">${metrics.map(([label, value, hint, symbol]) => `<div class="stat"><div class="stat-top">${label}<span class="stat-symbol">${symbol}</span></div><strong class="stat-value">${number(value)}</strong><small>${hint}</small></div>`).join('')}</div><section class="panel"><div class="panel-head"><div class="tabs"><span class="selected">แคมเปญทั้งหมด <span class="count">${all.length}</span></span></div><input class="search" id="campaign-search" type="search" placeholder="ค้นหาแคมเปญ…" aria-label="ค้นหาแคมเปญ"></div>${all.length ? campaignTable(all) : empty('เรื่องราวดี ๆ เริ่มต้นที่อีเมลฉบับแรก', 'สร้างแคมเปญ เลือกผู้รับ แล้วตรวจทุกอย่างให้พร้อม<br>ก่อนอนุมัติและจัดคิวส่งด้วยตัวคุณเอง', button('＋ สร้างแคมเปญแรก', 'new-campaign', '', 'primary'))}</section><div class="section-label">เริ่มต้นใน 3 ขั้นตอน <span>พร้อมเมื่อคุณพร้อม ไม่มีการส่งอัตโนมัติ</span></div><div class="starter">${[['01', 'เตรียมเทมเพลต', 'เขียนหัวเรื่อง เนื้อหา และตัวแปรส่วนบุคคล', 'templates', 'จัดการเทมเพลต'], ['02', 'เลือกคนที่อยากรับฟัง', 'เพิ่มผู้รับพร้อมความยินยอมรับการตลาด', 'audience', 'จัดการผู้รับ'], ['03', 'ตรวจแล้วค่อยส่ง', 'ดูตัวอย่าง อนุมัติ และนำแคมเปญเข้าคิว', 'settings', 'ดูความพร้อมการส่ง']].map(([n, title, detail, route, action]) => `<div class="step"><span class="step-number">${n}</span><div><h3>${title}</h3><p>${detail}</p><a href="#${route}">${action} →</a></div></div>`).join('')}</div>`;
}
function audiencePage() {
  return head('ผู้รับและความยินยอม', 'จัดการรายชื่อและสิทธิ์รับอีเมลการตลาดของแต่ละคน', button('＋ เพิ่มผู้รับ', 'new-recipient', '', 'primary')) + note() + `<section class="panel"><div class="panel-head"><h2>ผู้รับทั้งหมด <span class="count">${workspace.recipients.length}</span></h2><span class="small-text muted">Suppression มีผลเหนือ consent เสมอ</span></div>${workspace.recipients.length ? `<div class="table-wrap"><table><thead><tr><th>ผู้รับ</th><th>สิทธิ์ส่งการตลาด</th><th>ความยินยอม</th><th></th></tr></thead><tbody>${workspace.recipients.map((r) => `<tr><td><strong>${esc(r.displayName || r.email)}</strong><small>${esc(r.email)}</small></td><td><span class="badge ${r.eligible ? 'good' : 'bad'}">${r.eligible ? 'มีสิทธิ์ส่ง' : 'ระงับการส่ง'}</span><small>${esc(r.reason ?? '')}</small></td><td class="small-text">${r.consents.some((c) => c.type === 'EMAIL_MARKETING' && c.status === 'GRANTED') ? 'EMAIL_MARKETING · GRANTED' : 'ยังไม่ได้รับความยินยอม'}</td><td><div class="row">${button('แก้ไข', 'edit-recipient', `data-id="${esc(r.id)}"`, 'small')}${r.suppression ? '' : button('ระงับ', 'suppress', `data-id="${esc(r.id)}"`, 'small danger')}</div></td></tr>`).join('')}</tbody></table></div>` : empty('เริ่มจากผู้รับที่ยินยอม', 'เพิ่มรายชื่อและบันทึกความยินยอมที่ได้รับจริง<br>รายชื่อที่ยังไม่ยินยอมจะไม่ถูกนำเข้าคิวส่ง', button('＋ เพิ่มผู้รับ', 'new-recipient', '', 'primary'))}</section>`;
}
function templatesPage() {
  return head('เทมเพลต', 'ออกแบบข้อความครั้งเดียว เลือกใช้เวอร์ชันที่ตรงกับแต่ละแคมเปญ', button('＋ สร้างเทมเพลต', 'new-template', '', 'primary')) + note() + (workspace.templates.length ? `<div class="cards">${workspace.templates.map((t) => `<section class="panel template-card"><span class="badge">TEMPLATE · v${t.version}</span><h3>${esc(t.subject)}</h3><p>${esc(t.plainText)}</p><div class="row spread"><span class="small-text muted">${t.variables.length} ตัวแปร</span>${button('สร้างเวอร์ชันใหม่', 'edit-template', `data-id="${esc(t.id)}" data-version="${t.version}"`, 'small')}</div></section>`).join('')}</div>` : `<section class="panel">${empty('ข้อความที่เป็นตัวคุณ', 'เริ่มด้วยหัวเรื่องและเนื้อหาแบบข้อความ<br>ระบบจะสร้าง HTML ให้ หรือคุณจะเขียน HTML เองก็ได้', button('＋ สร้างเทมเพลตแรก', 'new-template', '', 'primary'))}</section>`);
}
function filesPage() {
  return head('ไฟล์แนบ', 'ลงทะเบียนข้อมูลอ้างอิงของไฟล์ โดยเก็บไฟล์ต้นฉบับไว้กับผู้ดูแลไฟล์', button('＋ เพิ่มข้อมูลไฟล์', 'new-file', '', 'primary')) + note() + `<section class="panel"><div class="panel-head"><h2>Attachment pool</h2><span class="badge">METADATA ONLY</span></div>${workspace.attachments.length ? `<div class="table-wrap"><table><thead><tr><th>ไฟล์</th><th>แหล่งอ้างอิง</th><th>ขนาด</th><th>SHA-256</th></tr></thead><tbody>${workspace.attachments.map((a) => `<tr><td>${esc(a.filename)}<small>${esc(a.mimeType)} · v${a.version}</small></td><td class="word-break">${esc(a.fileRef)}</td><td>${number(a.size)} bytes</td><td><code title="${esc(a.sha256)}">${esc(a.sha256.slice(0, 14))}…</code></td></tr>`).join('')}</tbody></table></div>` : empty('เชื่อมไฟล์กับแคมเปญ', 'เพิ่มชื่อไฟล์ ขนาด SHA-256 และ reference ไปยัง Files owner<br>การส่งไฟล์ต้องมี Files resolver ที่ตรวจสอบ hash ได้', button('＋ เพิ่มข้อมูลไฟล์', 'new-file', '', 'primary'))}</section>`;
}
function activityPage() {
  return head('ประวัติกิจกรรม', 'บันทึกการเปลี่ยนแปลงล่าสุด 50 รายการในพื้นที่นี้') + note() + `<section class="panel">${workspace.audit.length ? `<div class="table-wrap"><table><thead><tr><th>เวลา</th><th>กิจกรรม</th><th>ผู้ดำเนินการ</th><th>รายการอ้างอิง</th></tr></thead><tbody>${workspace.audit.map((e) => `<tr><td class="small-text">${date(e.at)}</td><td>${esc(e.action)}</td><td>${esc(e.actorId)}</td><td class="small-text word-break">${esc(e.subjectId)}</td></tr>`).join('')}</tbody></table></div>` : empty('ทุกการเปลี่ยนแปลงมีที่มา', 'กิจกรรมจะแสดงที่นี่เมื่อคุณเริ่มสร้างข้อมูล')}</section>`;
}
function settingsPage() {
  if (demoMode) {
    const simulatedStatus = gmailStatus?.status ?? 'DISCONNECTED';
    const gmailAction = simulatedStatus === 'CONNECTED'
      ? button('จำลองยกเลิกการเชื่อมต่อ', 'gmail-disconnect', '', 'danger')
      : button('จำลองเชื่อมต่อ Gmail', 'gmail-connect', '', 'primary');
    return head('การเชื่อมต่อ · DEMO', 'สถานะทั้งหมดในหน้านี้เป็นข้อมูลจำลอง ไม่ได้อ่านการตั้งค่าหรือฐานข้อมูลจริง') + note() + `<div class="settings-grid">${panel('พื้นที่จำลอง', `<div class="settings-item"><span>โหมด</span><span class="badge demo-badge-inline">DEMO · MEMORY ONLY</span></div><div class="settings-item"><span>ฐานข้อมูลจริง</span><strong>ไม่ได้เปิดใช้ในโหมดนี้</strong></div><p class="small-text muted">ข้อมูลตัวอย่างถูกสร้างใหม่ในหน่วยความจำ และหายเมื่อปิดหรือรีเซ็ตเดโม</p>${button('รีเซ็ตข้อมูลตัวอย่าง', 'demo-reset', '', 'small')}`)}${panel('Gmail จำลอง', `<div class="settings-item"><span>สถานะ</span>${badge(simulatedStatus)} <span class="badge demo-badge-inline">จำลอง</span></div>${gmailStatus?.email ? `<div class="settings-item"><span>ผู้ส่งตัวอย่าง</span><strong>${esc(gmailStatus.email)} · จำลอง</strong></div>` : ''}<p class="small-text muted">ปุ่มนี้เปลี่ยนสถานะในเดโมเท่านั้น ไม่เปิด Google, ไม่ใช้ OAuth และไม่ส่งอีเมล</p><div class="row">${gmailAction}</div>`)}${panel('การส่งและการวัดผลจำลอง', '<p class="small-text muted">อนุมัติ จัดคิว และ dispatch จะเปลี่ยนเฉพาะข้อมูลตัวอย่างภายในหน่วยความจำของเดโม</p><p class="small-text muted">open/click signals เป็นข้อมูลจำลอง ไม่ใช่หลักฐานการอ่านอีเมลจริง</p>')}</div>`;
  }
  const durable = workspace.health.persistence === 'sqlite';
  const status = gmailStatus ?? { status: 'NOT_CONFIGURED', missingFields: [] };
  const injectedLegacyGmail = status.status === 'NOT_CONFIGURED' && workspace.health.gmail === 'adapter_injected';
  const callbackOutcome = location.hash.split('/')[1];
  const callbackNotice = callbackOutcome === 'callback-connected'
    ? '<div class="notice callback-result good-result"><span>✓</span><span><strong>เชื่อมต่อ Gmail แล้ว</strong> · บัญชีที่ยืนยันจะแสดงด้านล่าง โปรดตรวจ sender ก่อนอนุมัติแคมเปญ</span></div>'
    : callbackOutcome === 'callback-cancelled'
      ? '<div class="notice callback-result"><span>ⓘ</span><span><strong>ยกเลิกการเชื่อมต่อ</strong> · ยังไม่มีการเปลี่ยนแปลงบัญชี Gmail</span></div>'
      : callbackOutcome === 'callback-failed'
        ? '<div class="notice callback-result"><span>ⓘ</span><span><strong>ยังยืนยันการเชื่อมต่อไม่ได้</strong> · ตรวจสถานะและลองเชื่อมต่อใหม่ได้ รายละเอียดจาก Google จะไม่แสดงในหน้านี้</span></div>'
        : '';
  const missing = status.missingFields?.length && !injectedLegacyGmail ? `<p class="small-text muted">ตั้งค่าตัวแปรสภาพแวดล้อมเหล่านี้ แล้วเริ่ม Emar ใหม่: ${status.missingFields.map((name) => `<code>${esc(name)}</code>`).join(' · ')}</p>` : '';
  const callback = status.redirectUri && !injectedLegacyGmail ? `<p class="small-text muted">Callback URI ใน Google Cloud: <code class="word-break">${esc(status.redirectUri)}</code></p>` : '';
  const setup = injectedLegacyGmail
    ? '<p class="small-text muted">Gmail ถูกจัดเตรียมผ่าน owner adapter; Emar ไม่ได้รับข้อมูลบัญชีจาก adapter นี้ จึงไม่แสดง email หรือสถานะ provider</p>'
    : status.status === 'NOT_CONFIGURED'
    ? `${missing}${callback}<p class="small-text muted">ตั้งค่าเฉพาะชื่อและค่าที่ผู้ดูแล Google Cloud ออกให้ใน environment ของ process; Emar ไม่อ่านไฟล์ .env อัตโนมัติและไม่รับ secret ผ่านหน้าเว็บ</p>`
    : `${callback}<p class="small-text muted">เข้าสู่ระบบ Google จะเริ่มเฉพาะเมื่อกดปุ่มด้วยตัวคุณเอง การเชื่อมต่อนี้ยังไม่ส่งอีเมลใด ๆ</p>`;
  const gmailAction = injectedLegacyGmail
    ? '<span class="badge warm">adapter_injected</span>'
    : status.status === 'CONNECTED'
    ? button('ยกเลิกการเชื่อมต่อ', 'gmail-disconnect', '', 'danger')
    : button(status.status === 'REAUTH_REQUIRED' ? 'เชื่อมต่อ Gmail ใหม่' : 'เชื่อมต่อ Gmail', 'gmail-connect', status.status === 'NOT_CONFIGURED' ? 'disabled' : '', 'primary');
  const gmailPanel = `<div class="settings-item"><span>สถานะบัญชี</span>${badge(injectedLegacyGmail ? 'adapter_injected' : status.status)}</div>${status.email ? `<div class="settings-item"><span>บัญชีที่ยืนยันแล้ว</span><strong>${esc(status.email)}</strong></div>` : ''}${status.scopes?.length ? `<div class="settings-item"><span>สิทธิ์ที่อนุญาต</span><span class="small-text">${esc(status.scopes.join(', '))}</span></div>` : ''}${setup}<div class="row">${gmailAction}</div>`;
  return head('การเชื่อมต่อและสถานะ', 'จัดการบัญชี Gmail และตรวจความพร้อมของบริการบนเครื่องนี้') + note() + callbackNotice + `<div class="settings-grid">${panel('พื้นที่ทำงาน', `<div class="settings-item"><span>โหมดใช้งาน</span><strong>Standalone · ผู้ดูแลบนเครื่องนี้</strong></div><div class="settings-item"><span>Tenant / Business</span><code>${esc(workspace.scope.tenantId)}</code></div><div class="settings-item"><span>เพดานส่งต่อวัน UTC</span><strong>${workspace.health.dailyLimit} ฉบับ</strong></div><div class="settings-item"><span>ฐานข้อมูล</span>${badge(durable ? 'SQLite · durable' : 'Memory · temporary')}</div><p class="small-text muted">เปิดใช้งานได้เฉพาะ localhost โดยอาศัยสิทธิ์ของผู้ใช้เครื่อง SQLite เก็บข้อมูลหลังปิดบริการ; ฐานข้อมูลหนึ่งไฟล์มี service process เป็นเจ้าของครั้งละหนึ่งตัว</p>`)}${panel('บัญชี Gmail', gmailPanel)}${panel('การเชื่อมต่อบริการ', [['Gmail API', injectedLegacyGmail ? 'adapter_injected' : status.status], ['Files resolver', workspace.health.files], ['Zuri Identity', 'NOT_CONFIGURED']].map(([name, value]) => `<div class="settings-item"><span>${name}</span>${badge(value)}</div>`).join(''))}</div>${panel('การส่งและการวัดผล', '<p class="small-text muted">หลังจัดคิว ต้องกดส่งคิวในหน้าแคมเปญเมื่อถึงกำหนด ไม่มี worker แคมเปญทำงานเบื้องหลัง หาก Gmail timeout ระบบจะบันทึก SEND_UNKNOWN และไม่ส่งซ้ำอัตโนมัติ</p><p class="small-text muted">เมื่อเปลี่ยนหรือเชื่อมต่อบัญชี Gmail ใหม่ ต้องตรวจและอนุมัติ campaign snapshot ใหม่ก่อน dispatch</p><p class="small-text muted">open_signal เป็นเพียงคำขอโหลดภาพ อาจเกิดจาก image proxy หรือ prefetch จึงไม่ใช่หลักฐานว่ามนุษย์อ่านข้อความแล้ว</p>')}`;
}

const dagKinds = ['draft', 'subject', 'segmentation_suggestion', 'followup_plan', 'review', 'human_gate'];
const dagLabels = { draft: 'เตรียมร่างข้อความ', subject: 'เสนอหัวเรื่อง', segmentation_suggestion: 'เสนอการแบ่งกลุ่มผู้รับ', followup_plan: 'วางแผนติดตาม', review: 'ตรวจทานผล', human_gate: 'จุดตัดสินใจของผู้ดูแล' };
const dagPresets = {
  campaign_prep: ['draft', 'subject', 'segmentation_suggestion', 'followup_plan', 'review', 'human_gate'],
  content_review: ['draft', 'review', 'human_gate'],
  audience_review: ['segmentation_suggestion', 'review', 'human_gate'],
};
function dagDialog() {
  const presets = `<option value="campaign_prep">เตรียมแคมเปญ · ร่าง → หัวเรื่อง → กลุ่ม → ติดตาม → ตรวจ → จุดตัดสินใจ</option><option value="content_review">ตรวจเนื้อหา · ร่าง → ตรวจ → จุดตัดสินใจ</option><option value="audience_review">ตรวจกลุ่ม · กลุ่มผู้รับ → ตรวจ → จุดตัดสินใจ</option>`;
  modal('สร้าง workflow เตรียมงาน', field('ชื่อ workflow', 'label', '', 'text', 'ใช้เพื่อระบุแผนงานนี้ในรายการ', 'required maxlength="120"') + `<label class="field">รูปแบบขั้นตอน<select name="preset">${presets}</select><small>สร้างเป็นลำดับ dependency ตาม preset และยังไม่มี agent ทำงานให้</small></label><p class="small-text muted">ขั้นตอน worker จะรอ integration ที่ได้รับอนุญาต ไม่มีการสร้างข้อความจริงหรืออนุมัติ/ส่ง campaign โดย workflow นี้</p>`, 'สร้าง workflow', async (data) => {
    const label = data.get('label').trim();
    const kinds = dagPresets[data.get('preset')];
    const nodes = kinds.map((kind, index) => ({
      id: `step-${String(index + 1).padStart(2, '0')}`,
      kind,
      dependsOn: index ? [`step-${String(index).padStart(2, '0')}`] : [],
      input: { label: dagLabels[kind], workflowLabel: label },
    }));
    const result = await api('/v1/dags', { id: id(), nodes });
    toast(`สร้าง workflow ${label} แล้ว`);
    return 'dags';
  });
}
function dagsPage(runs) {
  const runCards = runs.map((run) => {
    const label = run.nodes.find((node) => node.input?.workflowLabel)?.input.workflowLabel ?? run.id;
    const nodes = run.nodes.map((node) => `<div class="dag-node"><div class="dag-node-top"><strong>${esc(node.input?.label ?? dagLabels[node.kind] ?? node.kind)}</strong>${badge(node.state)}</div><div class="dag-node-meta"><span>ชนิด: ${esc(node.kind)}</span><span>ขึ้นต่อกับ: ${node.dependsOn.length ? node.dependsOn.map(esc).join(', ') : 'ไม่มี'}</span><span>worker: ${esc(node.claimedBy ?? 'ยังไม่มี')}</span><span>fence รุ่น: ${number(node.claimGeneration)} · ${node.state === 'running' ? 'มี fencing token ที่ใช้งานอยู่' : 'ไม่มี token ที่ใช้งานอยู่'}</span></div>${node.kind === 'human_gate' && node.state === 'ready' && run.status === 'active' ? `<div class="row">${button('ยืนยันว่าขั้นตรวจผ่าน', 'dag-gate-pass', `data-run="${esc(run.id)}" data-node="${esc(node.id)}"`, 'small primary')}${button('หยุด workflow', 'dag-gate-stop', `data-run="${esc(run.id)}" data-node="${esc(node.id)}"`, 'small danger')}</div>` : ''}${node.state === 'interrupted' && run.status === 'active' ? button('กู้คืนขั้นที่ขัดจังหวะ', 'dag-recover', `data-run="${esc(run.id)}" data-node="${esc(node.id)}"`, 'small') : ''}</div>`).join('');
    const actions = `<div class="row">${run.status === 'active' ? button('พัก workflow', 'dag-pause', `data-run="${esc(run.id)}"`, 'small danger') : ''}${run.status === 'paused' ? button('ดำเนิน workflow ต่อ', 'dag-resume', `data-run="${esc(run.id)}"`, 'small primary') : ''}</div>`;
    return `<section class="panel dag-run"><div class="panel-head"><div><h2>${esc(label)}</h2><small>${esc(run.id)} · สร้าง ${date(run.createdAt)} · ${badge(run.status)}</small></div>${actions}</div><div class="panel-body"><div class="dag-flow">${nodes || '<p class="small-text muted">ไม่มีขั้นตอน</p>'}</div>${run.pauseReason ? `<p class="small-text muted">เหตุผลที่พัก: ${esc(run.pauseReason)}</p>` : ''}</div></section>`;
  }).join('');
  const actions = `${demoMode ? button('จำลองขั้น worker ถัดไป', 'demo-advance', '', 'primary') : ''}${button('＋ สร้าง workflow', 'new-dag', '', demoMode ? '' : 'primary')}`;
  const guidance = demoMode
    ? '<div class="notice dag-note"><span>ⓘ</span><span><strong>การจำลองจะจบที่ human gate</strong> · กด advance หนึ่งครั้งเพื่อ claim worker nodes และอีกครั้งเพื่อบันทึกผล ไม่ข้ามการตัดสินใจของผู้ดูแลหรือเรียก Gmail</span></div>'
    : '<div class="notice dag-note"><span>ⓘ</span><span><strong>สถานะ workflow เป็นข้อมูลติดตาม</strong> · ผลของ node ต้องมาจาก authorized worker integration; ไม่มี model run อัตโนมัติ และ human gate ไม่อนุมัติ campaign หรือเรียก Gmail</span></div>';
  return head('เวิร์กโฟลว์เตรียมงาน', 'ติดตาม dependency, สถานะ worker และ human gate ของแต่ละ run', actions) + note() + guidance + `${runs.length ? runCards : empty('เริ่มจากแผนงานที่ตรวจสอบได้', 'สร้าง DAG แล้วดู dependency, claim และ human gate ได้ที่นี่', button('＋ สร้าง workflow', 'new-dag', '', 'primary'))}`;
}
function campaignPage(c, p) {
  const recipients = c.draft.recipientIds.map((rid) => workspace.recipients.find((r) => r.id === rid)).filter(Boolean);
  const queue = c.report.queue;
  const legacyAdapterReady = gmailStatus?.status === 'NOT_CONFIGURED' && workspace.health.gmail === 'adapter_injected';
  const canSend = c.status !== 'paused' && (demoMode ? gmailStatus?.status === 'CONNECTED' : gmailStatus?.status === 'CONNECTED' || legacyAdapterReady) && queue.some((q) => q.status === 'pending');
  const canApprove = ['draft', 'approved', 'paused'].includes(c.status) && p.recipients.eligible > 0;
  const approvalUnavailableReason = !['draft', 'approved', 'paused'].includes(c.status)
    ? `สถานะ ${c.status} ยังอนุมัติไม่ได้`
    : p.recipients.eligible === 0 ? 'ต้องมีผู้รับที่มีสิทธิ์อย่างน้อยหนึ่งคน' : '';
  const canSchedule = c.status === 'approved' && !queue.some((q) => ['pending', 'sending'].includes(q.status));
  const canPause = ['approved', 'scheduled'].includes(c.status) && queue.some((q) => ['pending', 'scheduled'].includes(q.status));
  const recipientOptions = recipients.map((recipient) => `<option value="${esc(recipient.id)}" ${p.sample.recipientId === recipient.id ? 'selected' : ''}>${esc(recipient.displayName || recipient.email)}</option>`).join('');
  const signalSummary = c.report.signals;
  const queueRows = queue.length
    ? `<div class="table-wrap"><table><thead><tr><th>ผู้รับ</th><th>สถานะ</th><th>กำหนดเวลา</th><th>ผล</th></tr></thead><tbody>${queue.map((item) => {
      const recipient = workspace.recipients.find((entry) => entry.id === item.recipientId);
      return `<tr><td>${esc(recipient?.displayName || recipient?.email || item.recipientId)}</td><td>${badge(item.status)}</td><td class="small-text">${date(item.scheduledAt)}</td><td class="small-text">${esc(item.errorCode ?? item.completedAt ?? '—')}</td></tr>`;
    }).join('')}</tbody></table></div>`
    : empty('ยังไม่มีรายการในคิว', 'อนุมัติ snapshot แล้วจึงจัดคิวผู้รับที่มีสิทธิ์ได้');
  const demoSignals = demoMode
    ? `<div class="row demo-actions">${[['open_signal', 'open'], ['click_observed', 'click'], ['reply_received', 'reply'], ['bounce_detected', 'bounce'], ['unsubscribed', 'unsubscribe']].map(([type, label]) => button(`จำลอง ${label}`, 'demo-signal', `data-id="${esc(c.id)}" data-type="${type}"`, 'small')).join('')}</div><p class="small-text muted">ข้อมูล signal เป็นตัวอย่างเพื่อสาธิตเท่านั้น ไม่ได้เกิดจากการเปิด คลิก หรือตอบอีเมลจริง</p>`
    : '';
  const signalsPanel = `<div class="signals"><div class="signal">Gmail รับแล้ว<b>${number(signalSummary.accepted_by_gmail)}</b></div><div class="signal">ผลส่งไม่ทราบ<b>${number(signalSummary.delivery_unknown)}</b></div><div class="signal">Open signal<b>${number(signalSummary.open_signal.count)}</b><small>${esc(signalSummary.open_signal.interpretation)}</small></div><div class="signal">Click signal<b>${number(signalSummary.click_observed)}</b></div><div class="signal">Reply received<b>${number(signalSummary.reply_received)}</b></div><div class="signal">Bounce detected<b>${number(signalSummary.bounce_detected)}</b></div><div class="signal">Unsubscribed<b>${number(signalSummary.unsubscribed)}</b></div></div>${demoSignals}`;
  const approval = c.approval
    ? `<p class="small-text muted">อนุมัติโดย ${esc(c.approval.approvedBy)} · ${date(c.approval.approvedAt)}</p><code class="hash">${esc(c.approval.payloadHash)}</code>`
    : '<p class="small-text muted">ยังไม่มี snapshot ที่อนุมัติ</p>';
  const editable = ['draft', 'approved', 'paused'].includes(c.status);
  const report = `<div class="detail-grid"><div>${panel('ตัวอย่างอีเมล', `<div class="preview-header"><small>หัวเรื่อง</small><strong>${esc(p.sample.subject)}</strong><label class="field">ดูตัวอย่างสำหรับ<select id="preview-recipient">${recipientOptions}</select></label><small>ผู้รับมีสิทธิ์ ${number(p.recipients.eligible)} จาก ${number(p.recipients.total)} คน · ถูกกันออก ${number(p.recipients.withheld.length)} คน</small></div><iframe id="email-preview" class="preview-frame" title="ตัวอย่างเนื้อหาอีเมล" sandbox="" referrerpolicy="no-referrer"></iframe><div class="panel-body"><h3>Plain text</h3><div class="plain-preview">${esc(p.sample.plainText)}</div></div>`)}${panel('คิวส่ง', queueRows)}${panel('สัญญาณและผลที่บันทึก', signalsPanel)}</div><div>${panel('ตรวจและอนุมัติ', `${approval}<p class="small-text muted">ผู้ส่งปัจจุบัน: ${demoMode ? 'demo-sender@example.test (จำลอง)' : gmailStatus?.email ? `${esc(gmailStatus.email)} · ตรวจบัญชีก่อนอนุมัติ` : 'ยังไม่มีบัญชี Gmail ที่ยืนยัน'}</p><label class="check-line"><input id="reviewed" type="checkbox" ${canApprove ? '' : 'disabled'}><span>ฉันตรวจหัวเรื่อง เนื้อหา ผู้รับ และ snapshot นี้แล้ว</span></label><p class="small-text muted">การอนุมัติใช้กับ snapshot ปัจจุบันเท่านั้น การแก้ไขหรือเปลี่ยนผู้ส่งต้องอนุมัติใหม่</p>${button(demoMode ? 'จำลองอนุมัติ snapshot' : 'อนุมัติ snapshot', 'approve', `data-id="${esc(c.id)}" disabled ${canApprove ? '' : `title="${esc(approvalUnavailableReason)}"`}`, 'primary')}`)}${panel('การดำเนินการ', `<div class="row">${button('แก้ไขฉบับร่าง', 'edit-campaign', `data-id="${esc(c.id)}" ${editable ? '' : 'disabled'}`, 'small')}${button('ทำสำเนา', 'clone-campaign', `data-id="${esc(c.id)}"`, 'small')}${canSchedule ? button(demoMode ? 'จำลองจัดคิว' : 'จัดคิว', 'schedule', `data-id="${esc(c.id)}"`, 'small primary') : ''}${canSend ? button(demoMode ? 'จำลอง dispatch' : 'ส่งคิวที่ถึงกำหนด', 'dispatch', `data-id="${esc(c.id)}"`, 'small primary') : ''}${canPause ? button('พักแคมเปญ', 'pause', `data-id="${esc(c.id)}"`, 'small danger') : ''}</div><p class="small-text muted">${demoMode ? 'ทุกการเปลี่ยนแปลงเป็นข้อมูลจำลอง ไม่เรียก Gmail และไม่ส่งข้อความจริง' : 'การจัดคิวไม่ส่งอีเมลเอง การ dispatch ต้องกดด้วยตนเองและใช้ Gmail ที่เชื่อมต่อแล้ว'}</p>${c.report.withheldRecipients.length ? `<p class="small-text muted">ผู้รับที่ถูกกันออกจากคิว: ${number(c.report.withheldRecipients.length)} คน</p>` : ''}`)}</div></div>`;
  return `<a class="back" href="#campaigns">← กลับไปหน้าแคมเปญ</a>${head(esc(c.name), `ฉบับที่ ${c.draftRevision} · ${recipients.length} คน · ${demoMode ? 'DEMO' : 'สถานะ'} ${badge(c.status)}`, `<div class="row">${button('แก้ไข', 'edit-campaign', `data-id="${esc(c.id)}" ${editable ? '' : 'disabled'}`, 'small')}${button('ทำสำเนา', 'clone-campaign', `data-id="${esc(c.id)}"`, 'small')}</div>`)}${note()}${report}`;
}
async function render(expectedEpoch = modeEpoch) {
  if (expectedEpoch !== modeEpoch || !workspace) return;
  const renderId = ++generation;
  const [route = 'campaigns', campaignId] = location.hash.slice(1).split('/');
  const active = route === 'campaign' ? 'campaigns' : route;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === active));
  $('#breadcrumb').textContent = names[active] ?? 'แคมเปญ'; $('#campaign-count').textContent = workspace.campaigns.length;
  try {
    if (route === 'dags') {
      const runs = await api('/v1/dags');
      if (renderId !== generation || expectedEpoch !== modeEpoch) return;
      $('#main').innerHTML = dagsPage(runs);
    } else if (route === 'campaign' && campaignId) {
      const c = workspace.campaigns.find((item) => item.id === decodeURIComponent(campaignId));
      if (!c) { location.hash = 'campaigns'; return; }
      const result = await api(`/v1/campaigns/${encodeURIComponent(c.id)}/preview`, {});
      if (renderId !== generation || expectedEpoch !== modeEpoch) return;
      preview = result;
      $('#main').innerHTML = campaignPage(c, result);
      setPreview(result);
    } else {
      if (renderId !== generation || expectedEpoch !== modeEpoch) return;
      $('#main').innerHTML = ({ campaigns: campaignsPage, audience: audiencePage, templates: templatesPage, files: filesPage, activity: activityPage, settings: settingsPage }[route] ?? campaignsPage)();
    }
  } catch (error) {
    if (expectedEpoch !== modeEpoch || error.staleMode) return;
    throw error;
  }
}
function sanitizePreviewHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html ?? '');
  const inertContent = template.content;
  inertContent.querySelectorAll('script,base,meta,noscript,iframe,object,embed,portal,svg,math,template').forEach((element) => element.remove());
  const blockedAttributes = new Set([
    'href', 'xlink:href', 'ping', 'target', 'download', 'src', 'srcset', 'srcdoc', 'poster', 'background',
    'action', 'formaction', 'formtarget', 'formmethod', 'data', 'codebase', 'archive', 'manifest', 'cite', 'longdesc',
  ]);
  inertContent.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || blockedAttributes.has(name)) element.removeAttribute(attribute.name);
    });
    if (['button', 'input', 'select', 'textarea', 'option'].includes(element.localName)) element.setAttribute('disabled', '');
    if (['a', 'area'].includes(element.localName)) {
      element.removeAttribute('role');
      element.removeAttribute('tabindex');
      element.setAttribute('aria-disabled', 'true');
    }
  });
  return template.innerHTML;
}
function setPreview(p) {
  const frame = $('#email-preview');
  if (!frame) return;
  const safeHtml = sanitizePreviewHtml(p.sample.html);
  frame.srcdoc = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:15px/1.9 Tahoma,sans-serif;padding:20px;color:#343b44;overflow-wrap:anywhere}a{color:#ce592e}</style>${safeHtml}`;
}
function field(label, name, value = '', type = 'text', hint = '', attrs = '') { return `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}>${hint ? `<small>${hint}</small>` : ''}</label>`; }
function textarea(label, name, value = '', hint = '', attrs = '') { return `<label class="field">${label}<textarea name="${name}" ${attrs}>${esc(value)}</textarea>${hint ? `<small>${hint}</small>` : ''}</label>`; }
function modal(title, body, save, onSubmit) {
  const modalEpoch = modeEpoch;
  $('#dialog-body').innerHTML = `<form id="edit-form"><div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="close" type="button" data-action="close" aria-label="ปิด">×</button></div><div class="form-body">${body}</div><div id="form-error" class="error" role="alert" hidden></div><div class="form-actions"><button class="btn" type="button" data-action="close">ยกเลิก</button><button class="btn primary" type="submit">${save}</button></div></form>`;
  $('#edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (modalEpoch !== modeEpoch) return;
    const submit = event.submitter;
    submit.disabled = true;
    $('#form-error').hidden = true;
    try {
      const destination = await onSubmit(new FormData(event.target), event.target);
      if (modalEpoch !== modeEpoch) return;
      $('#dialog').close();
      await refresh();
      if (modalEpoch !== modeEpoch) return;
      if (destination) location.hash = destination;
    } catch (error) {
      if (modalEpoch !== modeEpoch || error.staleMode) return;
      $('#form-error').textContent = error.message;
      $('#form-error').hidden = false;
      toast(error.message, true);
    } finally {
      if (modalEpoch === modeEpoch && submit.isConnected) submit.disabled = false;
    }
  });
  $('#dialog').showModal();
}
function recipientDialog(r) {
  modal(r ? 'แก้ไขผู้รับ' : 'เพิ่มผู้รับ', field('ชื่อผู้รับ', 'displayName', r?.displayName, 'text', '', 'maxlength="160"') + field('อีเมล', 'email', r?.email, 'email', '', 'required maxlength="254"') + `<label class="check-line"><input name="consent" type="checkbox" ${r?.consents.some((c) => c.type === 'EMAIL_MARKETING' && c.status === 'GRANTED') ? 'checked' : ''}><span>ได้รับความยินยอมรับอีเมลการตลาดแล้ว<small>เลือกเฉพาะเมื่อมีหลักฐานความยินยอมจากผู้รับจริง</small></span></label>${r?.suppression ? '<p class="small-text muted">รายชื่อนี้ถูกระงับอยู่ การเปลี่ยน consent จะไม่ยกเลิก suppression</p>' : ''}`, 'บันทึกผู้รับ', async (data) => { await api('/v1/recipients', { id: r?.id ?? id(), email: data.get('email').trim(), displayName: data.get('displayName').trim(), consents: [{ type: 'EMAIL_MARKETING', status: data.has('consent') ? 'GRANTED' : 'REVOKED' }] }); toast('บันทึกผู้รับแล้ว'); });
}
function templateDialog(t) {
  const version = t ? Math.max(...workspace.templates.filter((v) => v.id === t.id).map((v) => v.version)) + 1 : 1;
  modal(t ? `สร้างเทมเพลตเวอร์ชัน ${version}` : 'สร้างเทมเพลต', field('หัวเรื่องอีเมล', 'subject', t?.subject, 'text', 'ใช้ {{name}} เพื่อแทนชื่อผู้รับ หรือกำหนดตัวแปรอื่นตามต้องการ', 'required maxlength="998"') + textarea('เนื้อหา Plain text', 'plainText', t?.plainText, '', 'required') + `<label class="check-line"><input id="auto-html" name="autoHtml" type="checkbox" ${t ? '' : 'checked'}><span>สร้าง HTML จากเนื้อหาข้อความ</span></label><details ${t ? 'open' : ''}><summary>HTML สำหรับผู้ใช้ขั้นสูง</summary>${textarea('เนื้อหา HTML', 'html', t?.html, 'ไม่รองรับ JavaScript ในอีเมล')}</details><p class="small-text muted">เวอร์ชันที่บันทึกแล้วแก้ทับไม่ได้ การแก้ไขจะสร้างเวอร์ชันใหม่</p>`, 'บันทึกเทมเพลต', async (data) => {
    const plainText = data.get('plainText'), subject = data.get('subject');
    const html = data.has('autoHtml') ? `<div style="font-family:Tahoma,sans-serif;line-height:1.8">${esc(plainText).replace(/\n/g, '<br>')}</div>` : data.get('html');
    const variables = [...new Set([...`${subject}\n${plainText}\n${html}`.matchAll(/{{\s*([A-Za-z_][\w.-]*)\s*}}/g)].map((m) => m[1]))];
    await api('/v1/templates', { id: t?.id ?? id(), version, subject, html, plainText, variables }); toast('บันทึกเทมเพลตแล้ว');
  });
}
function campaignDialog(c, clone = false) {
  if (!workspace.templates.length || !workspace.recipients.length) {
    modal('เตรียมข้อมูลก่อนสร้างแคมเปญ', '<p>ต้องมีเทมเพลตและผู้รับอย่างน้อยหนึ่งรายการ เริ่มจากเมนูด้านล่างได้เลย</p><div class="row"><a class="btn" data-action="close" href="#templates">จัดการเทมเพลต →</a><a class="btn" data-action="close" href="#audience">จัดการผู้รับ →</a></div>', 'ปิด', async () => {}); return;
  }
  const selectedTemplate = c ? workspace.templates.findIndex((t) => t.id === c.draft.templateId && t.version === c.draft.templateVersion) : 0;
  modal(c && !clone ? 'แก้ไขฉบับร่าง' : 'สร้างแคมเปญ', field('ชื่อแคมเปญ', 'name', c ? `${c.name}${clone ? ' (สำเนา)' : ''}` : '', 'text', '', 'required maxlength="200"') + `<label class="field">เทมเพลต<select name="template">${workspace.templates.map((t, i) => `<option value="${i}" ${i === selectedTemplate ? 'selected' : ''}>${esc(t.subject)} · v${t.version}</option>`).join('')}</select></label><h3>เลือกผู้รับ</h3><p class="small-text muted">ผู้รับที่ถูกระงับหรือไม่ยินยอมจะถูกกันออกจากคิว</p><div class="selection">${workspace.recipients.map((r) => `<label><input type="checkbox" name="recipients" value="${esc(r.id)}" ${c?.draft.recipientIds.includes(r.id) ? 'checked' : ''}><span>${esc(r.displayName || r.email)}<small>${esc(r.email)}</small></span><span class="badge ${r.eligible ? 'good' : 'bad'}">${r.eligible ? 'มีสิทธิ์ส่ง' : 'ไม่มีสิทธิ์ส่ง'}</span></label>`).join('')}</div><div id="variable-fields"></div>${workspace.attachments.length ? `<details><summary>เลือกไฟล์แนบ</summary><div class="selection">${workspace.attachments.map((a) => `<label><input type="checkbox" name="attachments" value="${esc(a.id)}" ${c?.draft.attachmentIds.includes(a.id) ? 'checked' : ''}><span>${esc(a.filename)}<small>${number(a.size)} bytes · v${a.version}</small></span></label>`).join('')}</div></details>` : ''}<p class="small-text muted">การบันทึกฉบับร่างยังไม่ส่งอีเมล การแก้ไขหลังอนุมัติจะต้องอนุมัติอีกครั้ง</p>`, 'บันทึกฉบับร่าง', async (data) => {
    const t = workspace.templates[Number(data.get('template'))], recipientIds = data.getAll('recipients');
    if (!recipientIds.length) throw new Error('กรุณาเลือกผู้รับอย่างน้อยหนึ่งคน');
    const recipientVariables = Object.fromEntries(recipientIds.map((rid) => [rid, Object.fromEntries(t.variables.map((v, i) => [v, data.get(`variable-${workspace.recipients.findIndex((r) => r.id === rid)}-${i}`) ?? '']))]));
    const result = await api(c && !clone ? `/v1/campaigns/${encodeURIComponent(c.id)}` : '/v1/campaigns', { name: data.get('name').trim(), templateId: t.id, templateVersion: t.version, recipientIds, recipientVariables, attachmentIds: data.getAll('attachments') }, c && !clone ? 'PATCH' : 'POST');
    toast('บันทึกฉบับร่างแล้ว'); return `campaign/${encodeURIComponent(result.id)}`;
  });
  const values = structuredClone(c?.draft.recipientVariables ?? {});
  let displayed = [];
  const showVariables = () => {
    for (const [rid, variable, inputName] of displayed) (values[rid] ??= {})[variable] = $(`#edit-form [name="${inputName}"]`).value;
    const t = workspace.templates[Number($('#edit-form [name="template"]').value)];
    const selected = new FormData($('#edit-form')).getAll('recipients');
    displayed = [];
    $('#variable-fields').innerHTML = t.variables.length && selected.length ? '<h3>ตัวแปรแยกตามผู้รับ</h3>' + workspace.recipients.map((r, ri) => {
      if (!selected.includes(r.id)) return '';
      return `<details open><summary>${esc(r.displayName || r.email)}</summary>` + t.variables.map((v, vi) => {
        const inputName = `variable-${ri}-${vi}`;
        displayed.push([r.id, v, inputName]);
        return field(`{{${esc(v)}}}`, inputName, values[r.id]?.[v] ?? (v === 'name' ? r.displayName : ''), 'text', '', 'required');
      }).join('') + '</details>';
    }).join('') : '';
  };
  $('#edit-form [name="template"]').addEventListener('change', showVariables);
  $('#edit-form').querySelectorAll('[name="recipients"]').forEach((input) => input.addEventListener('change', showVariables));
  showVariables();
}
function fileDialog() {
  modal('เพิ่มข้อมูลไฟล์แนบ', field('ชื่อไฟล์', 'filename', '', 'text', '', 'required') + field('Files reference', 'fileRef', '', 'text', 'อ้างอิงไฟล์จาก Files owner ไม่ใช่การอัปโหลดไฟล์เข้า Emar', 'required') + field('SHA-256', 'sha256', '', 'text', '', 'required pattern="[a-fA-F0-9]{64}" maxlength="64"') + '<div class="form-grid">' + field('MIME type', 'mimeType', 'application/pdf', 'text', '', 'required') + field('ขนาด (bytes)', 'size', '', 'number', '', 'required min="0" step="1"') + '</div>', 'บันทึกข้อมูลไฟล์', async (data) => { await api('/v1/attachments', { id: id(), version: 1, filename: data.get('filename'), fileRef: data.get('fileRef'), sha256: data.get('sha256'), mimeType: data.get('mimeType'), size: Number(data.get('size')) }); toast('เพิ่มข้อมูลไฟล์แล้ว'); });
}
function updateDemoControls() {
  const toggle = $('#demo-toggle');
  toggle.textContent = demoMode ? 'Demo mode: ON' : 'Demo mode: OFF';
  toggle.setAttribute('aria-pressed', String(demoMode));
  toggle.dataset.mode = demoMode ? 'on' : 'off';
  toggle.classList.toggle('demo-active', demoMode);
  $('#demo-badge').hidden = !demoMode;
  $('#demo-reset').hidden = !demoMode;
  document.body.classList.toggle('demo-mode', demoMode);
}
function clearModeView() {
  modeEpoch++;
  generation++;
  previewRequestSequence++;
  workspace = undefined;
  gmailStatus = undefined;
  preview = undefined;
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
  const frame = $('#email-preview');
  if (frame) { frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; }
  const dialog = $('#dialog');
  if (dialog.open) dialog.close();
  $('#dialog-body').replaceChildren();
  $('#main').innerHTML = '<div class="loading">กำลังโหลดข้อมูลของโหมดที่เลือก…</div>';
  if (location.hash !== '#campaigns') location.hash = 'campaigns';
  return modeEpoch;
}
async function switchDemoMode(nextMode) {
  if (demoMode === nextMode) return;
  demoMode = nextMode;
  if (demoMode) demoApi = createDemoApi();
  updateDemoControls();
  const requestEpoch = clearModeView();
  try {
    await refresh();
    if (requestEpoch === modeEpoch) toast(demoMode ? 'DEMO เปิดแล้ว · ไม่มีการเรียก Gmail หรือฐานข้อมูลจริง' : 'กลับสู่พื้นที่ทำงานจริงแล้ว');
  } catch (error) {
    if (requestEpoch !== modeEpoch || error.staleMode) return;
    toast(error.message, true);
  }
}
async function resetDemo() {
  if (!demoMode) return;
  demoApi = createDemoApi();
  const requestEpoch = clearModeView();
  try {
    await refresh();
    if (requestEpoch === modeEpoch) toast('รีเซ็ตข้อมูล DEMO แล้ว');
  } catch (error) {
    if (requestEpoch !== modeEpoch || error.staleMode) return;
    toast(error.message, true);
  }
}
updateDemoControls();
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]'); if (!target || !target.isConnected || target.disabled) return;
  const action = target.dataset.action, itemId = target.dataset.id;
  if (action === 'demo-toggle') { await switchDemoMode(!demoMode); return; }
  if (action === 'demo-reset') { await resetDemo(); return; }
  const actionEpoch = modeEpoch;
  const actionUsesDemo = demoMode;
  const c = workspace?.campaigns.find((item) => item.id === itemId);
  try {
    if (action === 'close') { $('#dialog').close(); return; }
    if (action === 'new-recipient' || action === 'edit-recipient') return recipientDialog(workspace.recipients.find((r) => r.id === itemId));
    if (action === 'new-template' || action === 'edit-template') return templateDialog(workspace.templates.find((t) => t.id === itemId && t.version === Number(target.dataset.version)));
    if (['new-campaign', 'edit-campaign', 'clone-campaign'].includes(action)) return campaignDialog(c, action === 'clone-campaign');
    if (action === 'new-file') return fileDialog();
    if (action === 'new-dag') return dagDialog();
    if (action === 'demo-advance') {
      const result = await api('/v1/demo/advance', {});
      if (actionEpoch !== modeEpoch) return;
      const running = result.advanced.filter((node) => node.state === 'running').length;
      const completed = result.advanced.filter((node) => node.state === 'completed').length;
      toast(`DEMO: claim ${running} ขั้น · บันทึกผล ${completed} ขั้น · รอ human gate ${result.waitingAtHumanGates.length} จุด`);
      await refresh();
      return;
    }
    if (action === 'demo-signal') {
      await api('/v1/demo/signals', { campaignId: itemId, type: target.dataset.type });
      if (actionEpoch !== modeEpoch) return;
      toast('DEMO: เพิ่มสัญญาณจำลองแล้ว');
      await refresh();
      return;
    }
    if (action === 'gmail-connect') {
      const result = await api('/v1/integrations/gmail/connect', {});
      if (actionEpoch !== modeEpoch) return;
      if (actionUsesDemo) {
        toast('DEMO: สถานะ Gmail เปลี่ยนในตัวอย่างแล้ว ไม่มีการเปิด Google');
        await refresh();
        return;
      }
      window.location.assign(result.authorizationUrl);
      return;
    }
    if (action === 'gmail-disconnect') return modal(actionUsesDemo ? 'จำลองการยกเลิก Gmail' : 'ยกเลิกการเชื่อมต่อ Gmail', `<p>${actionUsesDemo ? 'เปลี่ยนสถานะ Gmail ในข้อมูลตัวอย่างเท่านั้น ไม่มีการลบ token จริงหรือเรียก provider' : 'Emar จะลบ token ที่เข้ารหัสและหยุดการ dispatch ผ่านบัญชีนี้ การอนุมัติ campaign เดิมจะต้องตรวจ sender ใหม่ก่อนส่งอีกครั้ง'}</p>`, actionUsesDemo ? 'จำลองยกเลิกการเชื่อมต่อ' : 'ยกเลิกการเชื่อมต่อ', async () => { await api('/v1/integrations/gmail/disconnect', {}); toast(actionUsesDemo ? 'DEMO: เปลี่ยนสถานะ Gmail แล้ว' : 'ยกเลิกการเชื่อมต่อ Gmail แล้ว'); });
    if (action === 'dag-pause') return modal('พัก workflow', field('เหตุผล', 'reason', 'พักโดยผู้ดูแล', 'text', '', 'required maxlength="500"'), 'พัก workflow', async (data) => { await api(`/v1/dags/${encodeURIComponent(target.dataset.run)}/pause`, { reason: data.get('reason').trim() }); toast(actionUsesDemo ? 'DEMO: พัก workflow แล้ว' : 'พัก workflow แล้ว'); });
    if (action === 'dag-resume') { await api(`/v1/dags/${encodeURIComponent(target.dataset.run)}/resume`, {}); if (actionEpoch !== modeEpoch) return; await refresh(); return; }
    if (action === 'dag-recover') { await api(`/v1/dags/${encodeURIComponent(target.dataset.run)}/nodes/${encodeURIComponent(target.dataset.node)}/recover`, {}); if (actionEpoch !== modeEpoch) return; toast(actionUsesDemo ? 'DEMO: คืนสถานะขั้นที่ขัดจังหวะแล้ว' : 'คืนสถานะขั้นที่ขัดจังหวะแล้ว'); await refresh(); return; }
    if (action === 'dag-gate-pass' || action === 'dag-gate-stop') {
      const decision = action === 'dag-gate-pass' ? 'pass' : 'stop';
      return modal('จุดตัดสินใจของผู้ดูแล', `<p>${decision === 'pass' ? 'ยืนยันว่าขั้นตรวจของ workflow นี้ผ่าน' : 'หยุด workflow นี้'} การตัดสินนี้ไม่อนุมัติ campaign และไม่เริ่มส่งอีเมล ${actionUsesDemo ? 'บันทึกเฉพาะข้อมูลจำลอง' : ''}</p>`, decision === 'pass' ? 'ยืนยันขั้นตรวจ' : 'หยุด workflow', async () => { await api(`/v1/dags/${encodeURIComponent(target.dataset.run)}/nodes/${encodeURIComponent(target.dataset.node)}/gate`, { decision }); toast(decision === 'pass' ? 'บันทึก human gate แล้ว' : 'workflow หยุดแล้ว'); });
    }
    if (action === 'suppress') return modal(actionUsesDemo ? 'จำลองการระงับ' : 'ระงับการส่งให้ผู้รับ', `<p>${actionUsesDemo ? 'เปลี่ยนข้อมูลผู้รับตัวอย่างเท่านั้น: ' : 'หยุดส่งอีเมลการตลาดให้ '}<strong>${esc(workspace.recipients.find((r) => r.id === itemId).email)}</strong>${actionUsesDemo ? '' : ' ความยินยอมที่มีอยู่จะไม่ยกเลิกการระงับนี้'}</p>`, 'ระงับการส่ง', async () => { await api(`/v1/recipients/${encodeURIComponent(itemId)}/suppression`, { reason: 'MANUAL_SUPPRESSION' }); toast(actionUsesDemo ? 'DEMO: ระงับผู้รับตัวอย่างแล้ว' : 'ระงับการส่งแล้ว'); });
    if (action === 'schedule') return modal(actionUsesDemo ? 'จำลองการจัดคิว' : 'กำหนดเวลาจัดคิว', field('เวลาที่เริ่มส่งได้', 'scheduledAt', '', 'datetime-local', 'เว้นว่างเพื่อเข้าคิวทันที ใช้เวลาท้องถิ่นของเครื่องนี้') + `<p class="small-text muted">${actionUsesDemo ? 'ระบบจะบันทึกคิวตัวอย่างในหน่วยความจำเท่านั้น ไม่ส่งอีเมล' : 'เมื่อถึงกำหนด ต้องกด “ส่งคิวที่ถึงกำหนด” ในหน้าแคมเปญเอง และต้องเชื่อม Gmail ก่อนส่ง'}</p>`, actionUsesDemo ? 'จำลองจัดคิว' : 'จัดคิวแคมเปญ', async (data) => { const scheduledAt = data.get('scheduledAt'); const result = await api(`/v1/campaigns/${encodeURIComponent(itemId)}/schedule`, scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}); toast(actionUsesDemo ? `DEMO: จัดคิว ${result.queued} รายการ` : `จัดคิว ${result.queued} รายการ · กันออก ${result.withheld.length} รายการ`); });
    if (action === 'dispatch') return modal(actionUsesDemo ? 'จำลอง dispatch' : 'เริ่มส่งอีเมลผ่าน Gmail', `<p>${actionUsesDemo ? 'จำลองผลของคิวที่ถึงกำหนดสำหรับแคมเปญ ' : 'ส่งเฉพาะคิวที่ถึงกำหนดของแคมเปญ '}<strong>${esc(c.name)}</strong> ${actionUsesDemo ? 'โดยไม่เรียก Gmail หรือส่งข้อความจริง' : 'ตาม snapshot ที่คุณอนุมัติไว้'}</p><p class="small-text muted">${actionUsesDemo ? 'ผลทั้งหมดอยู่ในข้อมูลตัวอย่างและหายเมื่อรีเซ็ตเดโม' : 'หากไม่ทราบผลการเรียก Gmail ระบบจะไม่ส่งซ้ำอัตโนมัติ'}</p>`, actionUsesDemo ? 'จำลองส่งคิว' : 'เริ่มส่งคิว', async () => { const result = await api(`/v1/campaigns/${encodeURIComponent(itemId)}/dispatch`, {}); toast(actionUsesDemo ? `DEMO: จำลองผลคิว ${result.considered} รายการแล้ว` : `ประมวลผลคิว ${result.considered} รายการ โปรดตรวจผลการส่งด้านล่าง`); });
    if (action === 'pause') return modal(actionUsesDemo ? 'จำลองการหยุดแคมเปญ' : 'หยุดแคมเปญ', `<p>${actionUsesDemo ? 'เปลี่ยนสถานะแคมเปญและคิวตัวอย่างเท่านั้น' : 'ยกเลิกคิวที่ยังไม่เริ่มส่ง ข้อความที่ Gmail รับไปแล้วจะเรียกคืนไม่ได้'}</p>`, actionUsesDemo ? 'จำลองหยุด' : 'หยุดแคมเปญ', async () => { await api(`/v1/campaigns/${encodeURIComponent(itemId)}/pause`, {}); toast(actionUsesDemo ? 'DEMO: หยุดแคมเปญตัวอย่างแล้ว' : 'หยุดแคมเปญแล้ว'); });
    if (action === 'approve') { if (!$('#reviewed')?.checked) return; target.disabled = true; await api(`/v1/campaigns/${encodeURIComponent(itemId)}/approve`, { draftHash: preview.draftHash }); if (actionEpoch !== modeEpoch) return; toast(actionUsesDemo ? 'DEMO: อนุมัติ snapshot ตัวอย่างแล้ว' : 'อนุมัติ snapshot นี้แล้ว'); await refresh(); }
  } catch (error) { if (actionEpoch !== modeEpoch || error.staleMode) return; toast(error.message, true); target.disabled = false; }
});
document.addEventListener('input', (event) => { if (event.target.id === 'campaign-search') document.querySelectorAll('[data-search]').forEach((row) => { row.hidden = !row.dataset.search.includes(event.target.value.toLowerCase()); }); });
document.addEventListener('change', async (event) => {
  if (event.target.id === 'reviewed') {
    const approve = $('[data-action="approve"]');
    if (approve) approve.disabled = !event.target.checked;
  }
  if (event.target.id === 'preview-recipient' && preview) {
    const changeEpoch = modeEpoch;
    const changeGeneration = generation;
    const changeSequence = ++previewRequestSequence;
    const recipientSelect = event.target;
    const campaignId = preview.campaignId;
    const draftHash = preview.draftHash;
    const stillCurrent = () => changeEpoch === modeEpoch
      && changeGeneration === generation
      && changeSequence === previewRequestSequence
      && recipientSelect.isConnected
      && $('#preview-recipient') === recipientSelect
      && preview?.campaignId === campaignId
      && preview?.draftHash === draftHash;
    try {
      const nextPreview = await api(`/v1/campaigns/${encodeURIComponent(campaignId)}/preview`, { recipientId: recipientSelect.value, draftHash });
      if (!stillCurrent()) return;
      preview = nextPreview;
      setPreview(preview);
      $('.preview-header strong').textContent = preview.sample.subject;
      $('.plain-preview').textContent = preview.sample.plainText;
    } catch (error) {
      if (!stillCurrent() || error.staleMode) return;
      toast(error.message, true);
    }
  }
});
window.addEventListener('hashchange', () => { if (workspace) render(modeEpoch).catch((error) => { if (!error.staleMode) toast(error.message, true); }); });
const startupEpoch = modeEpoch;
try {
  const response = await fetch('/ui/session', { method: 'POST', credentials: 'same-origin', headers: { 'x-emailmar-client': 'standalone-ui' } });
  const session = await response.json();
  if (!response.ok) throw new Error(session.error?.message ?? 'เปิด session ไม่สำเร็จ');
  csrf = session.csrfToken;
  if (startupEpoch === modeEpoch || !demoMode) await refresh();
} catch (error) {
  if (demoMode) { await refresh(); }
  else if (startupEpoch === modeEpoch) $('#main').innerHTML = `<div class="error-page"><h1>เปิดพื้นที่ทำงานไม่ได้</h1><p>${esc(error.message)}</p><p>เปิดผ่าน localhost และตรวจว่าบริการ Emar กำลังทำงานอยู่</p><a class="btn primary" href="/">ลองเปิดอีกครั้ง</a></div>`;
}
