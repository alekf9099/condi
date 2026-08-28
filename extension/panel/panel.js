/**
 * Condi 확장 — 사이드 패널 UI.
 *
 * 설정 편집 · 조건 오버라이드 · 실행 · 결과 표시 · 셀렉터 수집을 담당한다.
 * 실제 자동화는 서비스 워커(background.js)가 수행하고 여기로 이벤트를 보낸다.
 */
import { validateConfig } from '../lib/template.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'condi.config';

let config = null;

/* ── 탭 전환 ── */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.pane').forEach((p) => {
      p.classList.toggle('is-active', p.id === `panel-${tab.dataset.tab}`);
    });
  });
});

/* ── 서비스 워커 이벤트 수신 ──
   최상위 await(스토리지 로드)보다 **먼저** 등록해야 한다.
   그 뒤에 등록하면 패널을 열자마자 도착한 피커 결과가 유실된다. */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CONDI_EVENT') {
    const e = msg.event;
    if (e.phase === 'start') {
      addLog('info', e.profile, `타겟 ${e.target}`);
    } else if (e.phase === 'done') {
      $('summary').textContent = `통과 ${e.passed} · 실패 ${e.failed}`;
      if (e.detail) addLog('info', '완료', e.detail);
    } else {
      addLog(e.status, e.name, e.detail);
    }
  }
  if (msg?.type === 'CONDI_PICK_RESULT') {
    addPickedSelector(msg.selector, msg.suggestedName, msg.preview).catch((err) =>
      addLog('fail', '셀렉터 추가 실패', String(err?.message ?? err)),
    );
  }
  if (msg?.type === 'CONDI_PICK_CANCELLED') {
    $('pick').textContent = '요소 선택 시작';
  }
  return false;
});

/* ── 설정 로드/저장 ── */
const stored = await chrome.storage.local.get(STORAGE_KEY);
if (stored[STORAGE_KEY]) {
  $('config').value = stored[STORAGE_KEY];
  applyConfig(stored[STORAGE_KEY]);
}

$('config').addEventListener('input', (e) => applyConfig(e.target.value));

$('new-config').addEventListener('click', async () => {
  const skeleton = await newSkeletonConfig();
  applyConfig(JSON.stringify(skeleton, null, 2));
  $('config').value = JSON.stringify(skeleton, null, 2);
});

$('load-file').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  $('config').value = text;
  applyConfig(text);
});

$('format').addEventListener('click', () => {
  if (!config) return;
  const text = JSON.stringify(config, null, 2);
  $('config').value = text;
  applyConfig(text);
});

$('download').addEventListener('click', () => {
  if (!config) return;
  // downloads 권한을 요구하지 않도록 앵커 클릭으로 저장한다.
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${config.profileName ?? 'test-config'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function applyConfig(text) {
  const status = $('config-status');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    config = null;
    status.className = 'status err';
    status.textContent = `JSON 파싱 실패: ${err.message}`;
    setReady(false);
    return;
  }

  const problems = validateConfig(parsed);
  if (problems.length) {
    config = null;
    status.className = 'status err';
    status.textContent = `설정 검증 실패:\n- ${problems.join('\n- ')}`;
    setReady(false);
    return;
  }

  config = parsed;
  chrome.storage.local.set({ [STORAGE_KEY]: text });
  status.className = 'status ok';
  status.textContent = `유효한 설정 — 셀렉터 ${Object.keys(config.selectors).length}개, UI 단계 ${config.uiFlow?.length ?? 0}개`;
  $('target').textContent = `${config.profileName ?? ''} · ${config.target.baseUrl}`;
  renderConditions();
  renderSelectors();
  setReady(true);
}

function setReady(ready) {
  $('run').disabled = !ready;
}

/* ── 조건 오버라이드 ── */
function renderConditions() {
  const box = $('condition-fields');
  box.innerHTML = '';
  const entries = Object.entries(config.conditions);
  if (!entries.length) {
    box.innerHTML = '<p class="empty">조건이 정의되지 않았습니다.</p>';
    return;
  }
  for (const [key, value] of entries) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const label = document.createElement('label');
    label.textContent = key;
    label.htmlFor = `cond-${key}`;

    let input;
    if (typeof value === 'boolean') {
      input = document.createElement('select');
      for (const v of ['true', 'false']) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        opt.selected = String(value) === v;
        input.appendChild(opt);
      }
    } else {
      input = document.createElement('input');
      input.value = String(value);
    }
    input.id = `cond-${key}`;
    input.addEventListener('change', () => {
      config.conditions[key] = coerce(input.value, value);
      $('config').value = JSON.stringify(config, null, 2);
      chrome.storage.local.set({ [STORAGE_KEY]: $('config').value });
    });

    wrap.append(label, input);
    box.appendChild(wrap);
  }
}

/** 원래 타입을 보존하며 문자열 입력을 변환 */
function coerce(raw, original) {
  if (typeof original === 'boolean') return raw === 'true';
  if (typeof original === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

/* ── 실행 ── */
$('run').addEventListener('click', async () => {
  const tab = await getTargetTab();
  if (!tab?.id) {
    addLog('fail', '대상 탭을 찾을 수 없습니다', '검증할 웹페이지를 연 뒤 다시 실행하세요.');
    return;
  }

  $('log').innerHTML = '';
  $('summary').textContent = '';
  $('run').disabled = true;
  $('run').classList.add('is-running');
  $('run').textContent = '실행 중…';

  const res = await chrome.runtime.sendMessage({ type: 'CONDI_RUN', config, tabId: tab.id });

  $('run').disabled = false;
  $('run').classList.remove('is-running');
  $('run').textContent = '실행';
  if (!res?.ok) addLog('fail', '실행 중단', res?.error ?? '알 수 없는 오류');
});

function addLog(status, name, detail) {
  const li = document.createElement('li');
  li.className = status ?? 'info';
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
  li.scrollIntoView({ block: 'nearest' });
}

/* ── 셀렉터 피커 ── */
$('pick').addEventListener('click', async () => {
  const tab = await getTargetTab();
  if (!tab?.id) {
    addLog('fail', '대상 탭을 찾을 수 없습니다', '검증할 웹페이지를 연 뒤 다시 시도하세요.');
    return;
  }
  $('pick').textContent = '페이지에서 요소를 클릭하세요…';
  const res = await chrome.runtime.sendMessage({ type: 'CONDI_PICK', tabId: tab.id });
  if (!res?.ok) {
    $('pick').textContent = '요소 선택 시작';
    addLog('fail', '피커 실행 실패', res?.error ?? '');
  }
});

async function addPickedSelector(selector, suggestedName, preview) {
  $('pick').textContent = '요소 선택 시작';

  // 피커는 설정을 '만들기 위한' 도구다. 설정이 아직 없다고 고른 셀렉터를 버리면
  // 닭과 달걀이 된다. 없으면 현재 탭을 기준으로 최소 설정을 만들어 이어붙인다.
  if (!config) {
    config = await newSkeletonConfig();
    addLog('info', '새 설정을 만들었습니다', `타겟 ${config.target.baseUrl}`);
  }

  let name = suggestedName || 'element';
  let i = 2;
  while (name in config.selectors && config.selectors[name] !== selector) name = `${suggestedName}${i++}`;

  config.selectors[name] = selector;
  // applyConfig 를 거쳐야 검증 상태·실행 버튼·목록이 한꺼번에 갱신된다.
  applyConfig(JSON.stringify(config, null, 2));
  $('config').value = JSON.stringify(config, null, 2);
  addLog('pass', `셀렉터 추가: ${name}`, `${selector}${preview ? ` — "${preview}"` : ''}`);
}


/**
 * 자동화 대상 탭을 찾는다.
 *
 * 활성 탭이 항상 웹페이지인 것은 아니다. 패널을 별도 탭으로 띄웠거나
 * chrome:// 페이지가 앞에 있으면 활성 탭은 대상이 될 수 없다.
 * 그럴 때는 같은 창에서 가장 최근에 본 http(s) 탭으로 대체한다.
 */
async function getTargetTab() {
  const isWeb = (t) => t?.url && /^https?:/.test(t.url);

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isWeb(active)) return active;

  const webTabs = (await chrome.tabs.query({ currentWindow: true })).filter(isWeb);
  if (!webTabs.length) return null;
  // lastAccessed 가 없는 브라우저를 대비해 탭 순서를 보조 기준으로 쓴다
  return webTabs.sort((a, b) => (b.lastAccessed ?? b.index) - (a.lastAccessed ?? a.index))[0];
}

/** 현재 탭을 기준으로 최소 설정을 만든다 */
async function newSkeletonConfig() {
  const tab = await getTargetTab();
  let origin = 'https://example.com';
  let host = 'new-profile';
  try {
    if (tab?.url) {
      const u = new URL(tab.url);
      origin = u.origin;
      host = u.hostname;
    }
  } catch {
    /* 기본값 사용 */
  }
  return {
    profileName: host,
    target: { baseUrl: `${origin}/` },
    conditions: { userRole: 'default' },
    selectors: {},
    uiFlow: [],
  };
}

function renderSelectors() {
  const list = $('selector-list');
  list.innerHTML = '';
  const entries = Object.entries(config?.selectors ?? {});
  if (!entries.length) {
    list.innerHTML = '<li class="empty">설정에 셀렉터가 없습니다.</li>';
    return;
  }
  for (const [name, selector] of entries) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    const c = document.createElement('code');
    c.textContent = selector;
    li.append(n, c);
    list.appendChild(li);
  }
}
