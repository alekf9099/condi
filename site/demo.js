/**
 * Condi 랜딩 — 인터랙티브 데모.
 *
 * 확장에 들어 있는 실제 실행기(extension/content/runner.js)를 그대로 샌드박스
 * iframe에 주입하고, 조건에 맞는 uiFlow를 실행한다. 흉내 낸 로직이 아니다.
 *
 * API 선행 세팅만은 실제 서버가 없으므로 시뮬레이션하며, 그 사실을 로그에 밝힌다.
 */

const $ = (id) => document.getElementById(id);

/* ── 데모 설정 (실제 스키마와 동일한 모양) ── */
const SELECTORS = {
  welcomeBanner: '[data-testid="welcome-banner"]',
  adminDashboardMenu: '[data-testid="admin-dashboard"]',
  myPageLink: '[data-testid="mypage"]',
  loginEmailInput: '#email',
  orderListItem: '.order-list > li',
  emptyOrders: '[data-testid="empty-orders"]',
};

const UI_FLOW = [
  { action: 'expectVisible', target: 'welcomeBanner', description: '토큰 주입 후 로그인 상태로 진입' },
  { when: { 'conditions.userRole': 'admin' }, action: 'expectVisible', target: 'adminDashboardMenu',
    description: 'admin에게만 보이는 메뉴' },
  { when: { 'conditions.userRole': 'member' }, action: 'expectHidden', target: 'adminDashboardMenu',
    description: 'member에게는 보이면 안 됨' },
  { when: { 'conditions.userRole': 'member' }, action: 'expectVisible', target: 'myPageLink' },
  { when: { 'conditions.userRole': 'guest' }, action: 'expectVisible', target: 'loginEmailInput',
    description: '비로그인은 로그인 폼으로' },
  { when: { 'conditions.testDataCondition': 'hasActiveOrder' }, action: 'expectCount',
    target: 'orderListItem', count: 3, description: 'API로 시딩한 주문 3건' },
  { when: { 'conditions.testDataCondition': 'noOrder' }, action: 'expectVisible',
    target: 'emptyOrders', description: '주문이 없으면 빈 상태' },
];

const API_STEPS = [
  { name: 'issueToken', method: 'POST', path: '/auth/token' },
  { name: 'seedActiveOrder', method: 'POST', path: '/test-support/orders',
    when: { 'conditions.testDataCondition': 'hasActiveOrder' } },
];

const conditions = { userRole: 'admin', testDataCondition: 'hasActiveOrder' };

/* ── when 필터 (core/template.js 와 동일 규칙) ── */
function getByPath(root, expr) {
  return expr.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), root);
}
function matchesWhen(when, ctx) {
  if (!when) return true;
  return Object.entries(when).every(([p, v]) => getByPath(ctx, p) === v);
}

/* ── 샌드박스 페이지: 조건에 따라 다른 화면을 그린다 ── */
function sandboxHtml(c) {
  const loggedIn = c.userRole !== 'guest';
  const orders = c.testDataCondition === 'hasActiveOrder';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
    body{margin:0;padding:18px;background:#fff;color:#1a1a1f;
         font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
    .bar{display:flex;gap:8px;align-items:center;padding-bottom:12px;
         border-bottom:1px solid #e4e4ec;margin-bottom:14px;flex-wrap:wrap}
    .bar b{font-size:15px}
    .pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#eef;color:#4f46e5}
    .menu{font-size:12px;padding:3px 9px;border:1px solid #e4e4ec;border-radius:6px}
    .admin{background:#4f46e5;color:#fff;border-color:#4f46e5}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#6b6b78;margin:16px 0 8px}
    ul{margin:0;padding-left:18px}
    li{margin-bottom:4px}
    .empty{color:#8a8a99;font-style:italic}
    input{padding:7px 9px;border:1px solid #d4d4de;border-radius:6px;width:200px;font:inherit}
    label{display:block;font-size:12px;color:#6b6b78;margin-bottom:4px}
  </style></head><body>
  ${loggedIn ? `
    <div class="bar">
      <b data-testid="welcome-banner">환영합니다, ${c.userRole}님</b>
      <span class="pill">${c.userRole}</span>
      ${c.userRole === 'admin' ? '<span class="menu admin" data-testid="admin-dashboard">관리자 대시보드</span>' : ''}
      <span class="menu" data-testid="mypage">마이페이지</span>
    </div>
    <h2>주문 내역</h2>
    ${orders
      ? '<ul class="order-list"><li>주문 A · 배송중</li><li>주문 B · 결제완료</li><li>주문 C · 준비중</li></ul>'
      : '<p class="empty" data-testid="empty-orders">주문 내역이 없습니다.</p>'}
  ` : `
    <div class="bar"><b>로그인이 필요합니다</b></div>
    <label for="email">이메일</label>
    <input id="email" name="email" type="text" placeholder="you@example.com">
  `}
  </body></html>`;
}

/* ── 로그 ── */
function clearLog() {
  $('log').innerHTML = '';
  $('summary').textContent = '';
}
function addLog(status, name, detail) {
  const li = document.createElement('li');
  li.className = status;
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name;
  li.appendChild(n);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = detail;
    li.appendChild(d);
  }
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 실행 ── */
async function run() {
  const btn = $('run');
  btn.disabled = true;
  clearLog();

  const ctx = { conditions };
  addLog('info', 'conditions', JSON.stringify(conditions));

  // 1. API 선행 세팅 — 데모에는 실제 서버가 없어 시뮬레이션한다
  for (const step of API_STEPS) {
    await sleep(220);
    if (!matchesWhen(step.when, ctx)) {
      addLog('skip', step.name, 'when 조건 불일치로 건너뜀');
      continue;
    }
    addLog('pass', step.name, `${step.method} ${step.path} · 시뮬레이션`);
  }
  await sleep(180);
  addLog('pass', '주입', 'accessToken → localStorage · Authorization 헤더');

  // 2. 샌드박스를 조건에 맞게 다시 그리고 실제 실행기를 주입
  const frame = $('sandbox');
  await new Promise((resolve) => {
    frame.onload = resolve;
    frame.srcdoc = sandboxHtml(conditions);
  });

  const doc = frame.contentDocument;
  const script = doc.createElement('script');
  script.textContent = $('condi-runner-src').textContent;
  doc.body.appendChild(script);

  // 3. 조건에 맞는 단계만 남기고 셀렉터를 해석
  const flow = UI_FLOW.filter((s) => matchesWhen(s.when, ctx)).map((s) => ({
    ...s,
    selector: SELECTORS[s.target],
  }));
  const skipped = UI_FLOW.length - flow.length;
  if (skipped) addLog('skip', `${skipped}개 단계`, 'when 조건 불일치로 실행 대상에서 제외');

  await sleep(200);

  // 4. 확장의 실제 실행기로 흐름 수행
  const results = await frame.contentWindow.__condiRunFlow(flow, location.href, 2000);

  for (const r of results) {
    await sleep(160);
    addLog(r.ok ? 'pass' : 'fail', r.label, r.detail);
  }

  const failed = results.filter((r) => !r.ok).length;
  $('summary').textContent = `통과 ${results.length - failed} · 실패 ${failed}`;
  btn.disabled = false;
}

/* ── 조건 토글 ── */
function wireSegments(id, key) {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === btn));
    conditions[key] = btn.dataset.v;
    renderFlowJson();
    $('sandbox').srcdoc = sandboxHtml(conditions);
  });
}
wireSegments('role', 'userRole');
wireSegments('data', 'testDataCondition');
$('run').addEventListener('click', run);

/* ── uiFlow 미리보기: 지금 조건에서 실행될 단계를 표시 ── */
function renderFlowJson() {
  const ctx = { conditions };
  $('flow-json').textContent = UI_FLOW.map((s) => {
    const on = matchesWhen(s.when, ctx);
    const line = JSON.stringify(
      { action: s.action, target: s.target, ...(s.count ? { count: s.count } : {}), ...(s.when ? { when: s.when } : {}) },
    );
    return `${on ? '▸' : '·'} ${line}`;
  }).join('\n');
}

/* ── 커밋된 프로필 카드 ── */
function renderProfiles() {
  const box = $('profile-cards');
  const profiles = window.__CONDI_PROFILES__ ?? [];
  if (!profiles.length) {
    box.innerHTML = '<p class="note">커밋된 프로필이 없습니다.</p>';
    return;
  }
  box.innerHTML = profiles
    .map(
      (p) => `<article class="profile">
        <h4>${esc(p.name)}</h4>
        <p class="file">${esc(p.file)}</p>
        <dl>
          <dt>baseUrl</dt><dd>${esc(p.baseUrl)}</dd>
          <dt>셀렉터</dt><dd>${p.selectorCount}개</dd>
          <dt>UI 단계</dt><dd>${p.uiFlowCount}개</dd>
        </dl>
        <ul class="chips">${Object.entries(p.conditions)
          .map(([k, v]) => `<li><b>${esc(k)}</b> ${esc(JSON.stringify(v))}</li>`)
          .join('')}</ul>
      </article>`,
    )
    .join('');
}
function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ── 초기화 ── */
$('sandbox').srcdoc = sandboxHtml(conditions);
renderFlowJson();
renderProfiles();
